const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_DRAW_LOG = 400;

const DEFAULT_SETTINGS = {
  requireCheckinBeforeDraw: true,
  showRealtimeWall: true,
  anonymousWall: false
};

const DEFAULT_BLINDBOX_ITEMS = [
  { title: '深呼吸三连', detail: '吸气 4 秒，呼气 6 秒，重复 3 次。主打一个把魂拉回来。' },
  { title: '夸夸同桌', detail: '真诚夸一句身边的人，禁止“你真棒”这种摸鱼句式。' },
  { title: '摸鱼防抖', detail: '接下来 10 分钟，手机离手臂 1 米以上。' },
  { title: '站起来当 NPC', detail: '站起来绕一圈再坐下，假装触发了隐藏剧情。' },
  { title: '喝水暴击', detail: '现在喝 200ml 水，别等渴了再补。' },
  { title: '椅子拉伸流', detail: '肩颈和背部拉伸 2 分钟，动作慢一点。' },
  { title: '反内耗条款', detail: '写下“我现在最重要的一件事是：____”。' },
  { title: '5 分钟专注挑战', detail: '开计时 5 分钟，只做一件事，不切屏。' },
  { title: '社交能量包', detail: '给朋友发一句“今天你过得还行吗？”' },
  { title: '桌面清道夫', detail: '清掉桌面上 5 件不该出现的东西。' },
  { title: '表情包时间', detail: '发一个你最喜欢的表情包，然后继续干正事。' },
  { title: '梗王挑战', detail: '用一句“今天状态：____”描述你自己，越抽象越好。' },
  { title: '命运骰子', detail: '随机选一首歌，只听前 60 秒当作重启提示音。' },
  { title: '断网修仙 3 分钟', detail: '关掉消息提醒 3 分钟，体验人类原生专注。' },
  { title: '夸自己一句', detail: '写一句今天做得不错的地方，别谦虚。' }
];

function withPoolIds(items) {
  return items.map(item => ({
    id: randomUUID().slice(0, 8),
    title: item.title,
    detail: item.detail,
    enabled: true
  }));
}

function normalizeName(raw) {
  return String(raw || '').trim();
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.sessions || typeof parsed.sessions !== 'object') {
      return { sessions: {} };
    }
    Object.values(parsed.sessions).forEach(ensureSessionShape);
    return parsed;
  } catch {
    return { sessions: {} };
  }
}

const data = loadData();

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(type.includes('application/json') ? JSON.stringify(payload) : payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizeNames(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const out = [];
  for (const n of names) {
    const v = normalizeName(n);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeLocation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const accuracy = Number(raw.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    accuracy: Number.isFinite(accuracy) ? accuracy : null
  };
}

function normalizePhotoDataUrl(raw) {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  const isValidDataUrl = /^data:image\/(jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/i.test(value);
  if (!isValidDataUrl) return '';
  if (value.length > 700000) return '';
  return value;
}

function createSession(names) {
  const id = randomUUID().slice(0, 8);
  data.sessions[id] = {
    id,
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    blindboxPool: withPoolIds(DEFAULT_BLINDBOX_ITEMS),
    students: names.map(name => ({
      name,
      checkedIn: false,
      checkedInAt: '',
      checkinLocation: null,
      checkinPhoto: '',
      drawCount: 0,
      completeCount: 0,
      drawToken: ''
    })),
    drawLogs: []
  };
  saveData();
  return id;
}

function ensureSessionShape(session) {
  if (!session || typeof session !== 'object') return;
  if (!Array.isArray(session.students)) session.students = [];
  if (!Array.isArray(session.drawLogs)) session.drawLogs = [];
  if (!session.settings || typeof session.settings !== 'object') {
    session.settings = { ...DEFAULT_SETTINGS };
  } else {
    session.settings = {
      requireCheckinBeforeDraw: !!session.settings.requireCheckinBeforeDraw,
      showRealtimeWall: session.settings.showRealtimeWall !== false,
      anonymousWall: !!session.settings.anonymousWall
    };
  }
  if (!Array.isArray(session.blindboxPool) || !session.blindboxPool.length) {
    session.blindboxPool = withPoolIds(DEFAULT_BLINDBOX_ITEMS);
  }

  session.blindboxPool = session.blindboxPool.map(item => ({
    id: normalizeName(item && item.id) || randomUUID().slice(0, 8),
    title: sanitizePoolText(item && item.title, 40),
    detail: sanitizePoolText(item && item.detail, 180),
    enabled: item && item.enabled !== false
  })).filter(item => item.title && item.detail);

  if (!session.blindboxPool.length) {
    session.blindboxPool = withPoolIds(DEFAULT_BLINDBOX_ITEMS);
  }
  if (!session.blindboxPool.some(item => item.enabled)) {
    session.blindboxPool[0].enabled = true;
  }

  session.students.forEach(student => {
    student.name = normalizeName(student.name);
    if (typeof student.checkedIn !== 'boolean') student.checkedIn = false;
    if (typeof student.checkedInAt !== 'string') student.checkedInAt = '';
    if (!student.checkinLocation || typeof student.checkinLocation !== 'object') {
      student.checkinLocation = null;
    }
    if (typeof student.checkinPhoto !== 'string') student.checkinPhoto = '';
    if (typeof student.drawCount !== 'number' || student.drawCount < 0) student.drawCount = 0;
    if (typeof student.completeCount !== 'number' || student.completeCount < 0) student.completeCount = 0;
    if (typeof student.drawToken !== 'string') student.drawToken = '';
  });

  session.drawLogs = session.drawLogs.map(log => ({
    id: normalizeName(log && log.id) || randomUUID().slice(0, 8),
    name: normalizeName(log && log.name),
    title: sanitizePoolText(log && log.title, 40),
    detail: sanitizePoolText(log && log.detail, 180),
    createdAt: typeof (log && log.createdAt) === 'string' ? log.createdAt : new Date().toISOString(),
    completed: !!(log && log.completed),
    completedAt: typeof (log && log.completedAt) === 'string' ? log.completedAt : ''
  })).filter(log => log.name && log.title && log.detail);
}

function sanitizePoolText(raw, maxLen) {
  return String(raw || '').trim().slice(0, maxLen);
}

function maskNameInSession(session, name) {
  const idx = session.students.findIndex(s => s.name === name);
  if (idx < 0) return '匿名同学#?';
  return `匿名同学#${idx + 1}`;
}

function renderDrawLogForClient(session, log) {
  const name = session.settings.anonymousWall ? maskNameInSession(session, log.name) : log.name;
  return {
    id: log.id,
    name,
    title: log.title,
    detail: log.detail,
    createdAt: log.createdAt,
    completed: !!log.completed,
    completedAt: log.completedAt || ''
  };
}

function buildLeaderboard(session) {
  return session.students
    .map(student => {
      const drawCount = Number(student.drawCount) || 0;
      const completeCount = Number(student.completeCount) || 0;
      const rate = drawCount > 0 ? Math.round((completeCount / drawCount) * 100) : 0;
      return {
        name: session.settings.anonymousWall ? maskNameInSession(session, student.name) : student.name,
        drawCount,
        completeCount,
        completionRate: rate
      };
    })
    .sort((a, b) => {
      if (b.completeCount !== a.completeCount) return b.completeCount - a.completeCount;
      if (b.drawCount !== a.drawCount) return b.drawCount - a.drawCount;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
}

function toPublicStudent(student) {
  return {
    name: student.name,
    checkedIn: student.checkedIn,
    checkedInAt: student.checkedInAt,
    checkinLocation: student.checkinLocation,
    checkinPhoto: student.checkinPhoto,
    drawCount: student.drawCount,
    completeCount: student.completeCount
  };
}

function toPublicSession(session) {
  ensureSessionShape(session);
  return {
    id: session.id,
    createdAt: session.createdAt,
    total: session.students.length,
    checked: session.students.filter(s => s.checkedIn).length,
    students: session.students.map(toPublicStudent),
    drawLogs: session.settings.showRealtimeWall
      ? session.drawLogs.map(log => renderDrawLogForClient(session, log))
      : [],
    leaderboard: buildLeaderboard(session),
    settings: {
      requireCheckinBeforeDraw: session.settings.requireCheckinBeforeDraw,
      showRealtimeWall: session.settings.showRealtimeWall,
      anonymousWall: session.settings.anonymousWall
    }
  };
}

function toAdminSession(session) {
  ensureSessionShape(session);
  const totalDraw = session.students.reduce((acc, s) => acc + (Number(s.drawCount) || 0), 0);
  const totalComplete = session.students.reduce((acc, s) => acc + (Number(s.completeCount) || 0), 0);
  return {
    ...toPublicSession(session),
    drawLogs: session.drawLogs,
    blindboxPool: session.blindboxPool,
    stats: {
      totalDraw,
      totalComplete,
      overallCompletionRate: totalDraw > 0 ? Math.round((totalComplete / totalDraw) * 100) : 0
    }
  };
}

function getSessionOr404(res, id) {
  const session = data.sessions[id];
  if (!session) {
    send(res, 404, { error: '场次不存在' });
    return null;
  }
  ensureSessionShape(session);
  return session;
}

function pickBlindboxFromSession(session) {
  const enabled = session.blindboxPool.filter(item => item.enabled);
  if (!enabled.length) return null;
  const idx = Math.floor(Math.random() * enabled.length);
  return enabled[idx];
}

function ensureStudentToken(student) {
  if (!student.drawToken) {
    student.drawToken = randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return student.drawToken;
}

function verifyDrawIdentity(student, token) {
  const safeToken = normalizeName(token);
  if (!safeToken || !student.drawToken || safeToken !== student.drawToken) return false;
  return true;
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
  };
  const type = typeMap[ext] || 'text/plain; charset=utf-8';
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      send(res, 404, 'Not Found', 'text/plain; charset=utf-8');
      return;
    }
    send(res, 200, buf, type);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    try {
      const body = await parseBody(req);
      const names = sanitizeNames(body.students);
      if (names.length === 0) {
        send(res, 400, { error: '请至少提供 1 个学生名字' });
        return;
      }
      const id = createSession(names);
      send(res, 200, { id, adminUrl: `/admin/${id}`, checkinUrl: `/checkin/${id}` });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const adminGetMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/admin$/);
  if (req.method === 'GET' && adminGetMatch) {
    const session = getSessionOr404(res, adminGetMatch[1]);
    if (!session) return;
    send(res, 200, toAdminSession(session));
    return;
  }

  const sessionGetMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && sessionGetMatch) {
    const session = getSessionOr404(res, sessionGetMatch[1]);
    if (!session) return;
    send(res, 200, toPublicSession(session));
    return;
  }

  const checkinMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/checkin$/);
  if (req.method === 'POST' && checkinMatch) {
    try {
      const session = getSessionOr404(res, checkinMatch[1]);
      if (!session) return;
      const body = await parseBody(req);
      const name = normalizeName(body.name);
      if (!name) {
        send(res, 400, { error: '名字不能为空' });
        return;
      }
      const student = session.students.find(s => s.name === name);
      if (!student) {
        send(res, 404, { error: '名单里没有这个名字' });
        return;
      }
      if (student.checkedIn) {
        send(res, 409, { error: '该同学已签到' });
        return;
      }
      const location = normalizeLocation(body.location);
      if (!location) {
        send(res, 400, { error: '未获取到定位信息，请开启定位后重试' });
        return;
      }
      const photo = normalizePhotoDataUrl(body.photoDataUrl);
      if (!photo) {
        send(res, 400, { error: '未获取到拍照照片，请允许摄像头并拍照后重试' });
        return;
      }

      student.checkedIn = true;
      student.checkedInAt = new Date().toISOString();
      student.checkinLocation = location;
      student.checkinPhoto = photo;
      const drawToken = ensureStudentToken(student);
      saveData();

      send(res, 200, {
        ok: true,
        checkedInAt: student.checkedInAt,
        location: student.checkinLocation,
        drawToken
      });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const claimTokenMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/claim-token$/);
  if (req.method === 'POST' && claimTokenMatch) {
    try {
      const session = getSessionOr404(res, claimTokenMatch[1]);
      if (!session) return;
      const body = await parseBody(req);
      const name = normalizeName(body.name);
      if (!name) {
        send(res, 400, { error: '名字不能为空' });
        return;
      }
      const student = session.students.find(s => s.name === name);
      if (!student) {
        send(res, 404, { error: '名单里没有这个名字' });
        return;
      }
      if (session.settings.requireCheckinBeforeDraw && !student.checkedIn) {
        send(res, 403, { error: '当前场次要求先签到后抽卡，暂时不能领取口令' });
        return;
      }
      if (student.drawToken) {
        send(res, 409, { error: '这个名字已在另一设备绑定口令，请在原设备操作' });
        return;
      }
      const drawToken = ensureStudentToken(student);
      saveData();
      send(res, 200, { ok: true, drawToken });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const drawMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/draw$/);
  if (req.method === 'POST' && drawMatch) {
    try {
      const session = getSessionOr404(res, drawMatch[1]);
      if (!session) return;

      const body = await parseBody(req);
      const name = normalizeName(body.name);
      const token = normalizeName(body.token);
      if (!name) {
        send(res, 400, { error: '名字不能为空' });
        return;
      }
      const student = session.students.find(s => s.name === name);
      if (!student) {
        send(res, 404, { error: '名单里没有这个名字' });
        return;
      }
      if (session.settings.requireCheckinBeforeDraw && !student.checkedIn) {
        send(res, 403, { error: '请先完成签到再抽盲盒' });
        return;
      }
      if (!verifyDrawIdentity(student, token)) {
        send(res, 401, { error: '口令校验失败，请在你的签到设备操作' });
        return;
      }

      const picked = pickBlindboxFromSession(session);
      if (!picked) {
        send(res, 400, { error: '当前梗池没有可抽取项，请联系管理员' });
        return;
      }

      const now = new Date().toISOString();
      const log = {
        id: randomUUID().slice(0, 8),
        name: student.name,
        title: picked.title,
        detail: picked.detail,
        createdAt: now,
        completed: false,
        completedAt: ''
      };

      session.drawLogs.unshift(log);
      if (session.drawLogs.length > MAX_DRAW_LOG) {
        session.drawLogs.length = MAX_DRAW_LOG;
      }
      student.drawCount += 1;
      saveData();

      send(res, 200, {
        ok: true,
        draw: renderDrawLogForClient(session, log),
        drawRaw: log,
        drawCount: student.drawCount,
        completeCount: student.completeCount
      });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const completeMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/complete$/);
  if (req.method === 'POST' && completeMatch) {
    try {
      const session = getSessionOr404(res, completeMatch[1]);
      if (!session) return;

      const body = await parseBody(req);
      const name = normalizeName(body.name);
      const token = normalizeName(body.token);
      const drawId = normalizeName(body.drawId);
      if (!name) {
        send(res, 400, { error: '名字不能为空' });
        return;
      }

      const student = session.students.find(s => s.name === name);
      if (!student) {
        send(res, 404, { error: '名单里没有这个名字' });
        return;
      }
      if (!verifyDrawIdentity(student, token)) {
        send(res, 401, { error: '口令校验失败，请在你的签到设备操作' });
        return;
      }

      let target = null;
      if (drawId) {
        target = session.drawLogs.find(log => log.id === drawId && log.name === name);
      } else {
        target = session.drawLogs.find(log => log.name === name && !log.completed);
      }

      if (!target) {
        send(res, 404, { error: '未找到可完成的挑战记录' });
        return;
      }
      if (target.completed) {
        send(res, 409, { error: '这条挑战已经标记完成了' });
        return;
      }

      target.completed = true;
      target.completedAt = new Date().toISOString();
      student.completeCount += 1;
      saveData();

      send(res, 200, {
        ok: true,
        drawId: target.id,
        completedAt: target.completedAt,
        drawCount: student.drawCount,
        completeCount: student.completeCount
      });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const settingsMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/settings$/);
  if (req.method === 'POST' && settingsMatch) {
    try {
      const session = getSessionOr404(res, settingsMatch[1]);
      if (!session) return;
      const body = await parseBody(req);

      if (typeof body.requireCheckinBeforeDraw === 'boolean') {
        session.settings.requireCheckinBeforeDraw = body.requireCheckinBeforeDraw;
      }
      if (typeof body.showRealtimeWall === 'boolean') {
        session.settings.showRealtimeWall = body.showRealtimeWall;
      }
      if (typeof body.anonymousWall === 'boolean') {
        session.settings.anonymousWall = body.anonymousWall;
      }

      saveData();
      send(res, 200, { ok: true, settings: session.settings });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const poolAddMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/pool\/add$/);
  if (req.method === 'POST' && poolAddMatch) {
    try {
      const session = getSessionOr404(res, poolAddMatch[1]);
      if (!session) return;
      const body = await parseBody(req);

      const title = sanitizePoolText(body.title, 40);
      const detail = sanitizePoolText(body.detail, 180);
      const enabled = body.enabled !== false;
      if (!title || !detail) {
        send(res, 400, { error: '标题和内容都不能为空' });
        return;
      }

      session.blindboxPool.unshift({
        id: randomUUID().slice(0, 8),
        title,
        detail,
        enabled
      });
      saveData();
      send(res, 200, { ok: true, blindboxPool: session.blindboxPool });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const poolUpdateMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/pool\/update$/);
  if (req.method === 'POST' && poolUpdateMatch) {
    try {
      const session = getSessionOr404(res, poolUpdateMatch[1]);
      if (!session) return;
      const body = await parseBody(req);
      const id = normalizeName(body.id);
      if (!id) {
        send(res, 400, { error: '缺少条目 ID' });
        return;
      }

      const idx = session.blindboxPool.findIndex(item => item.id === id);
      if (idx < 0) {
        send(res, 404, { error: '梗条目不存在' });
        return;
      }

      const current = session.blindboxPool[idx];
      const next = {
        ...current,
        title: typeof body.title === 'string' ? sanitizePoolText(body.title, 40) : current.title,
        detail: typeof body.detail === 'string' ? sanitizePoolText(body.detail, 180) : current.detail,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled
      };

      if (!next.title || !next.detail) {
        send(res, 400, { error: '标题和内容都不能为空' });
        return;
      }

      const candidatePool = session.blindboxPool.map((item, i) => (i === idx ? next : item));
      if (!candidatePool.some(item => item.enabled)) {
        send(res, 400, { error: '至少要保留 1 条可抽取内容（enabled）' });
        return;
      }

      session.blindboxPool = candidatePool;
      saveData();
      send(res, 200, { ok: true, blindboxPool: session.blindboxPool });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const poolDeleteMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/pool\/delete$/);
  if (req.method === 'POST' && poolDeleteMatch) {
    try {
      const session = getSessionOr404(res, poolDeleteMatch[1]);
      if (!session) return;
      const body = await parseBody(req);
      const id = normalizeName(body.id);
      if (!id) {
        send(res, 400, { error: '缺少条目 ID' });
        return;
      }
      if (session.blindboxPool.length <= 1) {
        send(res, 400, { error: '至少保留 1 条梗，不能全部删除' });
        return;
      }

      const nextPool = session.blindboxPool.filter(item => item.id !== id);
      if (nextPool.length === session.blindboxPool.length) {
        send(res, 404, { error: '梗条目不存在' });
        return;
      }
      if (!nextPool.some(item => item.enabled)) {
        nextPool[0].enabled = true;
      }

      session.blindboxPool = nextPool;
      saveData();
      send(res, 200, { ok: true, blindboxPool: session.blindboxPool });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  if (req.method === 'GET' && pathname.match(/^\/admin\/[a-zA-Z0-9-]+$/)) {
    serveFile(res, path.join(PUBLIC_DIR, 'admin.html'));
    return;
  }

  if (req.method === 'GET' && pathname.match(/^\/checkin\/[a-zA-Z0-9-]+$/)) {
    serveFile(res, path.join(PUBLIC_DIR, 'checkin.html'));
    return;
  }

  send(res, 404, { error: 'Not Found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Check-in app running at http://${HOST}:${PORT}`);
});
