const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'data.json');
const SQLITE_FILE = path.join(__dirname, 'app.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_DRAW_LOG = 400;
const MAX_AUDIT_LOG = 300;
const ACTION_COOLDOWN_MS = 2000;

const DEFAULT_SETTINGS = {
  requireCheckinBeforeDraw: true,
  showRealtimeWall: true,
  anonymousWall: false,
  obfuscateLocation: false
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

function normalizeName(raw) {
  return String(raw || '').trim();
}

function sanitizeText(raw, maxLen) {
  return String(raw || '').trim().slice(0, maxLen);
}

function toDateKey(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function withPoolIds(items) {
  return items.map(item => ({
    id: randomUUID().slice(0, 8),
    title: item.title,
    detail: item.detail,
    enabled: true
  }));
}

function genAdminKey() {
  return randomUUID().replace(/-/g, '').slice(0, 18);
}

function genDrawToken() {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

function initSqliteStore() {
  try {
    // Node >= 22 provides this builtin module.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(SQLITE_FILE);
    db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    return db;
  } catch {
    return null;
  }
}

const sqliteDb = initSqliteStore();

function loadFromFile() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.sessions || typeof parsed.sessions !== 'object') return { sessions: {} };
    return parsed;
  } catch {
    return { sessions: {} };
  }
}

function loadFromSqlite() {
  if (!sqliteDb) return { sessions: {} };
  try {
    const stmt = sqliteDb.prepare('SELECT v FROM kv WHERE k = ?');
    const row = stmt.get('sessions');
    if (!row || typeof row.v !== 'string') return { sessions: {} };
    const parsed = JSON.parse(row.v);
    if (!parsed.sessions || typeof parsed.sessions !== 'object') return { sessions: {} };
    return parsed;
  } catch {
    return { sessions: {} };
  }
}

function saveToSqlite(payload) {
  if (!sqliteDb) return;
  const stmt = sqliteDb.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)');
  stmt.run('sessions', JSON.stringify(payload));
}

function loadData() {
  const fileData = loadFromFile();
  if (!sqliteDb) return fileData;

  const sqlData = loadFromSqlite();
  const sqlCount = Object.keys(sqlData.sessions || {}).length;
  const fileCount = Object.keys(fileData.sessions || {}).length;

  if (sqlCount > 0) return sqlData;
  if (fileCount > 0) {
    saveToSqlite(fileData);
    return fileData;
  }
  return { sessions: {} };
}

const data = loadData();

function saveData() {
  if (sqliteDb) {
    saveToSqlite(data);
  }
  // Keep JSON backup for portability and debugging.
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function blurLocation(loc) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  return {
    lat: Number(Number(loc.lat).toFixed(3)),
    lng: Number(Number(loc.lng).toFixed(3)),
    accuracy: loc.accuracy
  };
}

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Admin-Actor'
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

function ensureStudentShape(student) {
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
  if (typeof student.lastDrawAt !== 'number' || student.lastDrawAt < 0) student.lastDrawAt = 0;
  if (typeof student.lastCompleteAt !== 'number' || student.lastCompleteAt < 0) student.lastCompleteAt = 0;
}

function ensureSessionShape(session) {
  if (!session || typeof session !== 'object') return;
  if (!Array.isArray(session.students)) session.students = [];
  if (!Array.isArray(session.drawLogs)) session.drawLogs = [];
  if (!Array.isArray(session.auditLogs)) session.auditLogs = [];

  if (!session.settings || typeof session.settings !== 'object') {
    session.settings = { ...DEFAULT_SETTINGS };
  } else {
    session.settings = {
      requireCheckinBeforeDraw: session.settings.requireCheckinBeforeDraw !== false,
      showRealtimeWall: session.settings.showRealtimeWall !== false,
      anonymousWall: !!session.settings.anonymousWall,
      obfuscateLocation: !!session.settings.obfuscateLocation
    };
  }

  if (typeof session.adminKey !== 'string' || !session.adminKey) {
    session.adminKey = genAdminKey();
  }

  if (!Array.isArray(session.blindboxPool) || !session.blindboxPool.length) {
    session.blindboxPool = withPoolIds(DEFAULT_BLINDBOX_ITEMS);
  }

  session.blindboxPool = session.blindboxPool
    .map(item => ({
      id: normalizeName(item && item.id) || randomUUID().slice(0, 8),
      title: sanitizeText(item && item.title, 40),
      detail: sanitizeText(item && item.detail, 180),
      enabled: item && item.enabled !== false
    }))
    .filter(item => item.title && item.detail);

  if (!session.blindboxPool.length) {
    session.blindboxPool = withPoolIds(DEFAULT_BLINDBOX_ITEMS);
  }
  if (!session.blindboxPool.some(item => item.enabled)) {
    session.blindboxPool[0].enabled = true;
  }

  session.students.forEach(ensureStudentShape);

  session.drawLogs = session.drawLogs
    .map(log => ({
      id: normalizeName(log && log.id) || randomUUID().slice(0, 8),
      name: normalizeName(log && log.name),
      title: sanitizeText(log && log.title, 40),
      detail: sanitizeText(log && log.detail, 180),
      createdAt: typeof (log && log.createdAt) === 'string' ? log.createdAt : new Date().toISOString(),
      completed: !!(log && log.completed),
      completedAt: typeof (log && log.completedAt) === 'string' ? log.completedAt : ''
    }))
    .filter(log => log.name && log.title && log.detail);

  session.auditLogs = session.auditLogs
    .map(log => ({
      id: normalizeName(log && log.id) || randomUUID().slice(0, 8),
      action: sanitizeText(log && log.action, 40) || 'unknown',
      detail: sanitizeText(log && log.detail, 240),
      actor: sanitizeText(log && log.actor, 40) || 'teacher',
      ip: sanitizeText(log && log.ip, 80),
      createdAt: typeof (log && log.createdAt) === 'string' ? log.createdAt : new Date().toISOString()
    }))
    .filter(log => log.action);
}

Object.values(data.sessions).forEach(ensureSessionShape);
saveData();

function createSession(names) {
  const id = randomUUID().slice(0, 8);
  data.sessions[id] = {
    id,
    createdAt: new Date().toISOString(),
    adminKey: genAdminKey(),
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
      drawToken: '',
      lastDrawAt: 0,
      lastCompleteAt: 0
    })),
    drawLogs: [],
    auditLogs: []
  };
  saveData();
  return id;
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
    student.drawToken = genDrawToken();
  }
  return student.drawToken;
}

function verifyDrawIdentity(student, token) {
  const safe = normalizeName(token);
  if (!safe || !student.drawToken || safe !== student.drawToken) return false;
  return true;
}

function maskNameInSession(session, name) {
  const idx = session.students.findIndex(s => s.name === name);
  if (idx < 0) return '匿名同学#?';
  return `匿名同学#${idx + 1}`;
}

function renderDrawLogForClient(session, log) {
  const displayName = session.settings.anonymousWall ? maskNameInSession(session, log.name) : log.name;
  return {
    id: log.id,
    name: displayName,
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

function buildClassBadges(session) {
  const total = session.students.length;
  const checked = session.students.filter(s => s.checkedIn).length;
  const totalDraw = session.students.reduce((acc, s) => acc + (Number(s.drawCount) || 0), 0);
  const totalComplete = session.students.reduce((acc, s) => acc + (Number(s.completeCount) || 0), 0);
  const rate = totalDraw > 0 ? Math.round((totalComplete / totalDraw) * 100) : 0;

  const badges = [];
  if (total > 0 && checked === total) badges.push('全员到齐');
  if (totalDraw >= Math.max(10, total * 3)) badges.push('抽卡活跃班');
  if (totalComplete >= Math.max(5, total)) badges.push('执行力班');
  if (totalDraw >= 5 && rate >= 70) badges.push('高完成率');
  if (session.settings.anonymousWall) badges.push('匿名护盾');

  return badges.map((label, idx) => ({ id: `badge-${idx + 1}`, label }));
}

function toPublicStudent(session, student) {
  const location = session.settings.obfuscateLocation ? blurLocation(student.checkinLocation) : student.checkinLocation;
  return {
    name: student.name,
    checkedIn: student.checkedIn,
    checkedInAt: student.checkedInAt,
    checkinLocation: location,
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
    students: session.students.map(s => toPublicStudent(session, s)),
    drawLogs: session.settings.showRealtimeWall
      ? session.drawLogs.map(log => renderDrawLogForClient(session, log))
      : [],
    leaderboard: buildLeaderboard(session),
    classBadges: buildClassBadges(session),
    settings: {
      requireCheckinBeforeDraw: session.settings.requireCheckinBeforeDraw,
      showRealtimeWall: session.settings.showRealtimeWall,
      anonymousWall: session.settings.anonymousWall,
      obfuscateLocation: session.settings.obfuscateLocation
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
    auditLogs: session.auditLogs.slice(0, 200),
    stats: {
      totalDraw,
      totalComplete,
      overallCompletionRate: totalDraw > 0 ? Math.round((totalComplete / totalDraw) * 100) : 0
    }
  };
}

function calcCurrentStreakDays(logs) {
  const doneDates = new Set(
    logs
      .filter(log => log.completed && log.completedAt)
      .map(log => toDateKey(log.completedAt))
      .filter(Boolean)
  );
  let streak = 0;
  const cursor = new Date();
  while (true) {
    const key = toDateKey(cursor);
    if (!doneDates.has(key)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '';
}

function resolveActor(req, url, body) {
  const byBody = sanitizeText(body && body.actor, 40);
  const byHeader = sanitizeText(req.headers['x-admin-actor'], 40);
  const byQuery = sanitizeText(url.searchParams.get('actor'), 40);
  return byBody || byHeader || byQuery || 'teacher';
}

function addAuditLog(session, req, actor, action, detail) {
  session.auditLogs.unshift({
    id: randomUUID().slice(0, 8),
    action: sanitizeText(action, 40) || 'unknown',
    detail: sanitizeText(detail, 240),
    actor: sanitizeText(actor, 40) || 'teacher',
    ip: sanitizeText(getClientIp(req), 80),
    createdAt: new Date().toISOString()
  });
  if (session.auditLogs.length > MAX_AUDIT_LOG) {
    session.auditLogs.length = MAX_AUDIT_LOG;
  }
}

function readAdminKey(req, url, body) {
  const fromHeader = normalizeName(req.headers['x-admin-key']);
  const fromQuery = normalizeName(url.searchParams.get('k'));
  const fromBody = normalizeName(body && body.adminKey);
  return fromHeader || fromQuery || fromBody;
}

function isAdminAuthorized(session, key) {
  const safe = normalizeName(key);
  return !!safe && safe === session.adminKey;
}

function requireAdminAuth(req, res, url, session, body = null) {
  const key = readAdminKey(req, url, body);
  if (!isAdminAuthorized(session, key)) {
    send(res, 401, { error: '管理口令无效，请使用完整后台链接' });
    return false;
  }
  return true;
}

function checkActionCooldown(lastTs, nowTs) {
  if (!lastTs) return 0;
  const elapsed = nowTs - lastTs;
  if (elapsed >= ACTION_COOLDOWN_MS) return 0;
  return ACTION_COOLDOWN_MS - elapsed;
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
      if (!names.length) {
        send(res, 400, { error: '请至少提供 1 个学生名字' });
        return;
      }
      const id = createSession(names);
      const session = data.sessions[id];
      send(res, 200, {
        id,
        adminUrl: `/admin/${id}?k=${encodeURIComponent(session.adminKey)}`,
        checkinUrl: `/checkin/${id}`,
        adminKey: session.adminKey
      });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const adminGetMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/admin$/);
  if (req.method === 'GET' && adminGetMatch) {
    const session = getSessionOr404(res, adminGetMatch[1]);
    if (!session) return;
    if (!requireAdminAuth(req, res, url, session)) return;
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
        location: session.settings.obfuscateLocation ? blurLocation(student.checkinLocation) : student.checkinLocation,
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
        send(res, 401, { error: '口令校验失败，请在绑定口令的设备操作' });
        return;
      }

      const nowMs = Date.now();
      const waitMs = checkActionCooldown(student.lastDrawAt, nowMs);
      if (waitMs > 0) {
        send(res, 429, { error: `操作太快啦，请 ${Math.ceil(waitMs / 1000)} 秒后再抽`, retryAfterMs: waitMs });
        return;
      }

      const picked = pickBlindboxFromSession(session);
      if (!picked) {
        send(res, 400, { error: '当前梗池没有可抽取项，请联系管理员' });
        return;
      }

      const log = {
        id: randomUUID().slice(0, 8),
        name: student.name,
        title: picked.title,
        detail: picked.detail,
        createdAt: new Date().toISOString(),
        completed: false,
        completedAt: ''
      };

      session.drawLogs.unshift(log);
      if (session.drawLogs.length > MAX_DRAW_LOG) {
        session.drawLogs.length = MAX_DRAW_LOG;
      }
      student.drawCount += 1;
      student.lastDrawAt = nowMs;
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
        send(res, 401, { error: '口令校验失败，请在绑定口令的设备操作' });
        return;
      }

      const nowMs = Date.now();
      const waitMs = checkActionCooldown(student.lastCompleteAt, nowMs);
      if (waitMs > 0) {
        send(res, 429, { error: `操作太快啦，请 ${Math.ceil(waitMs / 1000)} 秒后再提交`, retryAfterMs: waitMs });
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
      student.lastCompleteAt = nowMs;
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

  const meMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/me$/);
  if (req.method === 'POST' && meMatch) {
    try {
      const session = getSessionOr404(res, meMatch[1]);
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
      if (!verifyDrawIdentity(student, token)) {
        send(res, 401, { error: '口令校验失败，请重新绑定口令' });
        return;
      }

      const history = session.drawLogs
        .filter(log => log.name === student.name)
        .slice(0, 80);

      send(res, 200, {
        ok: true,
        name: student.name,
        drawCount: student.drawCount,
        completeCount: student.completeCount,
        streakDays: calcCurrentStreakDays(history),
        history
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
      if (!requireAdminAuth(req, res, url, session, body)) return;

      if (typeof body.requireCheckinBeforeDraw === 'boolean') {
        session.settings.requireCheckinBeforeDraw = body.requireCheckinBeforeDraw;
      }
      if (typeof body.showRealtimeWall === 'boolean') {
        session.settings.showRealtimeWall = body.showRealtimeWall;
      }
      if (typeof body.anonymousWall === 'boolean') {
        session.settings.anonymousWall = body.anonymousWall;
      }
      if (typeof body.obfuscateLocation === 'boolean') {
        session.settings.obfuscateLocation = body.obfuscateLocation;
      }

      const actor = resolveActor(req, url, body);
      addAuditLog(session, req, actor, 'settings.update', '更新了场次开关配置');
      saveData();
      send(res, 200, { ok: true, settings: session.settings });
    } catch (err) {
      send(res, 400, { error: err.message || '请求错误' });
    }
    return;
  }

  const privacyClearMatch = pathname.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)\/privacy\/clear$/);
  if (req.method === 'POST' && privacyClearMatch) {
    try {
      const session = getSessionOr404(res, privacyClearMatch[1]);
      if (!session) return;

      const body = await parseBody(req);
      if (!requireAdminAuth(req, res, url, session, body)) return;

      session.students.forEach(student => {
        student.checkinLocation = null;
        student.checkinPhoto = '';
      });

      const actor = resolveActor(req, url, body);
      addAuditLog(session, req, actor, 'privacy.clear', '一键清空了全部自拍和定位数据');
      saveData();
      send(res, 200, { ok: true });
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
      if (!requireAdminAuth(req, res, url, session, body)) return;

      const title = sanitizeText(body.title, 40);
      const detail = sanitizeText(body.detail, 180);
      const enabled = body.enabled !== false;
      if (!title || !detail) {
        send(res, 400, { error: '标题和内容都不能为空' });
        return;
      }

      session.blindboxPool.unshift({ id: randomUUID().slice(0, 8), title, detail, enabled });

      const actor = resolveActor(req, url, body);
      addAuditLog(session, req, actor, 'pool.add', `新增梗：${title}`);
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
      if (!requireAdminAuth(req, res, url, session, body)) return;

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
        title: typeof body.title === 'string' ? sanitizeText(body.title, 40) : current.title,
        detail: typeof body.detail === 'string' ? sanitizeText(body.detail, 180) : current.detail,
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
      const actor = resolveActor(req, url, body);
      addAuditLog(session, req, actor, 'pool.update', `更新梗：${next.title}`);
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
      if (!requireAdminAuth(req, res, url, session, body)) return;

      const id = normalizeName(body.id);
      if (!id) {
        send(res, 400, { error: '缺少条目 ID' });
        return;
      }
      if (session.blindboxPool.length <= 1) {
        send(res, 400, { error: '至少保留 1 条梗，不能全部删除' });
        return;
      }

      const target = session.blindboxPool.find(item => item.id === id);
      const nextPool = session.blindboxPool.filter(item => item.id !== id);
      if (nextPool.length === session.blindboxPool.length) {
        send(res, 404, { error: '梗条目不存在' });
        return;
      }
      if (!nextPool.some(item => item.enabled)) {
        nextPool[0].enabled = true;
      }

      session.blindboxPool = nextPool;
      const actor = resolveActor(req, url, body);
      addAuditLog(session, req, actor, 'pool.delete', `删除梗：${target ? target.title : id}`);
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
    const id = pathname.split('/').pop();
    const session = getSessionOr404(res, id);
    if (!session) return;
    const key = normalizeName(url.searchParams.get('k'));
    if (!isAdminAuthorized(session, key)) {
      send(res, 403, 'Forbidden: invalid admin key', 'text/plain; charset=utf-8');
      return;
    }
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
  if (sqliteDb) {
    console.log(`SQLite persistence enabled at ${SQLITE_FILE}`);
  } else {
    console.log('SQLite module unavailable, using JSON persistence');
  }
});
