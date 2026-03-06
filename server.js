const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_DRAW_LOG = 300;

const BLINDBOX_ITEMS = [
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

function ensureSessionShape(session) {
  if (!Array.isArray(session.students)) session.students = [];
  if (!Array.isArray(session.drawLogs)) session.drawLogs = [];
  session.students.forEach(student => {
    if (typeof student.drawCount !== 'number') student.drawCount = 0;
  });
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
    const v = String(n || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function createSession(names) {
  const id = randomUUID().slice(0, 8);
  data.sessions[id] = {
    id,
    createdAt: new Date().toISOString(),
    students: names.map(name => ({
      name,
      checkedIn: false,
      checkedInAt: '',
      checkinLocation: null,
      checkinPhoto: '',
      drawCount: 0
    })),
    drawLogs: []
  };
  saveData();
  return id;
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
  // Limit to about 500KB payload in base64 form
  if (value.length > 700000) return '';
  return value;
}

function toPublicSession(session) {
  ensureSessionShape(session);
  return {
    id: session.id,
    createdAt: session.createdAt,
    total: session.students.length,
    checked: session.students.filter(s => s.checkedIn).length,
    students: session.students,
    drawLogs: session.drawLogs
  };
}

function normalizeName(raw) {
  return String(raw || '').trim();
}

function pickBlindbox() {
  const idx = Math.floor(Math.random() * BLINDBOX_ITEMS.length);
  return BLINDBOX_ITEMS[idx];
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

  const sessionGetMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)$/);
  if (req.method === 'GET' && sessionGetMatch) {
    const id = sessionGetMatch[1];
    const session = data.sessions[id];
    if (!session) {
      send(res, 404, { error: '场次不存在' });
      return;
    }
    ensureSessionShape(session);
    send(res, 200, toPublicSession(session));
    return;
  }

  const checkinMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/checkin$/);
  if (req.method === 'POST' && checkinMatch) {
    try {
      const id = checkinMatch[1];
      const session = data.sessions[id];
      if (!session) {
        send(res, 404, { error: '场次不存在' });
        return;
      }
      ensureSessionShape(session);
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
      saveData();
      send(res, 200, {
        ok: true,
        checkedInAt: student.checkedInAt,
        location: student.checkinLocation
      });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const drawMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/draw$/);
  if (req.method === 'POST' && drawMatch) {
    try {
      const id = drawMatch[1];
      const session = data.sessions[id];
      if (!session) {
        send(res, 404, { error: '场次不存在' });
        return;
      }
      ensureSessionShape(session);
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
      if (!student.checkedIn) {
        send(res, 403, { error: '请先完成签到再抽盲盒' });
        return;
      }

      const draw = pickBlindbox();
      const log = {
        id: randomUUID().slice(0, 8),
        name: student.name,
        title: draw.title,
        detail: draw.detail,
        createdAt: new Date().toISOString()
      };
      session.drawLogs.unshift(log);
      if (session.drawLogs.length > MAX_DRAW_LOG) {
        session.drawLogs.length = MAX_DRAW_LOG;
      }
      student.drawCount += 1;
      saveData();
      send(res, 200, {
        ok: true,
        draw: log,
        drawCount: student.drawCount
      });
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
