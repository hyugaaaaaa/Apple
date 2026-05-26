'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_PATH = process.env.RELAY_DATA_PATH || path.join(__dirname, 'relay-state.json');

const AGENT_TOKEN = String(process.env.AGENT_TOKEN || '').trim();
const REQUIRE_PIN = process.env.REQUIRE_PIN !== 'false';
const DEBUG_UI = process.env.DEBUG_UI === 'true';

// Env-var PIN seeding for stateless deployments (e.g. Cloud Run).
// APP_PIN seeds the PIN for DEFAULT_MAC_ID (or 'default-mac' if unset).
// MAC_PINS allows multiple macs: "macId1:pin1,macId2:pin2"
const DEFAULT_MAC_ID = String(process.env.DEFAULT_MAC_ID || '').trim();
const APP_PIN_SEED = String(process.env.APP_PIN || '').trim();
const MAC_PINS_SEED = String(process.env.MAC_PINS || '').trim();

const ITEMS_PER_PAGE = 8;
const MAX_PAGES = 3;
const MAX_COMMANDS = ITEMS_PER_PAGE * MAX_PAGES;

const SESSION_TOKEN_TTL_MS = Number(process.env.SESSION_TOKEN_TTL_MS || (12 * 60 * 60 * 1000));
const PIN_MAX_ATTEMPTS = Math.max(5, Number(process.env.PIN_MAX_ATTEMPTS || 5));
const PIN_LOCK_MS = Number(process.env.PIN_LOCK_MS || (10 * 60 * 1000));
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 12000);
const ADMIN_SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || (8 * 60 * 60 * 1000));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const STATIC_ROUTE_ALIASES = new Map([
  ['/admin', '/admin.html'],
  ['/admin/', '/admin.html'],
  ['/auth', '/auth.html'],
  ['/auth/', '/auth.html'],
  ['/controller', '/controller.html'],
  ['/controller/', '/controller.html'],
  ['/lp', '/lp-onboarding.html'],
  ['/lp/', '/lp-onboarding.html'],
  ['/mac-setup', '/mac-setup.html'],
  ['/mac-setup/', '/mac-setup.html']
]);

// =========================================================
// State
// =========================================================

// Per-Mac runtime state (volatile — rebuilt when agent connects)
// macId -> { ws, deviceName, rpcSeq, pending, appsCache, iconCache, connectedAt, lastSeenAt }
const agents = new Map();

// Per-Mac persisted config
// macId -> { pin, pinSource, selectedSlots }
const macConfigs = new Map();

// Auth (shared)
const sessions = new Map();    // token -> { clientIp, deviceId, macId, expiresAt }
const pinAttempts = new Map(); // attemptKey -> { failCount, lockUntil }
const adminSessions = new Map(); // token -> { macId, expiresAt }

// =========================================================
// Helpers
// =========================================================

function normalizePin(pin) {
  const v = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(v)) return '';
  return v;
}

function generatePin(digits = 6) {
  const max = 10 ** digits;
  return String(Math.floor(Math.random() * max)).padStart(digits, '0');
}

function normalizeDeviceId(id) {
  const v = String(id || '').trim();
  if (!v || v.length > 96) return '';
  if (!/^[a-zA-Z0-9._:-]+$/.test(v)) return '';
  return v;
}

function normalizeDeviceName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function appPathToName(appPath) {
  return path.basename(String(appPath || ''), '.app').trim() || 'App';
}

// =========================================================
// Per-Mac config management
// =========================================================

function getOrCreateMacConfig(macId) {
  let config = macConfigs.get(macId);
  if (!config) {
    config = {
      pin: generatePin(6),
      pinSource: 'generated',
      selectedSlots: Array(MAX_COMMANDS).fill(null)
    };
    macConfigs.set(macId, config);
    saveData();
  }
  return config;
}

function rotateMacPin(macId) {
  const config = macConfigs.get(macId);
  if (!config) return null;
  config.pin = generatePin(6);
  config.pinSource = 'generated';
  for (const [token, s] of sessions.entries()) {
    if (s.macId === macId) sessions.delete(token);
  }
  for (const [token, s] of adminSessions.entries()) {
    if (s.macId === macId) adminSessions.delete(token);
  }
  saveData();
  return config.pin;
}

function findMacByPin(inputPin) {
  const normalized = normalizePin(inputPin);
  if (!normalized) return null;
  for (const [macId, config] of macConfigs.entries()) {
    if (config.pin === normalized) return macId;
  }
  return null;
}

// =========================================================
// Data persistence
// =========================================================

function ensureDataDir() {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

    if (parsed.macs && typeof parsed.macs === 'object') {
      for (const [rawMacId, macData] of Object.entries(parsed.macs)) {
        const macId = normalizeDeviceId(rawMacId);
        const pin = normalizePin(macData?.pin);
        if (!macId || !pin) continue;
        const slots = Array.isArray(macData.selectedSlots)
          ? macData.selectedSlots.map((v) => (v ? String(v) : null)).slice(0, MAX_COMMANDS)
          : Array(MAX_COMMANDS).fill(null);
        while (slots.length < MAX_COMMANDS) slots.push(null);
        macConfigs.set(macId, { pin, pinSource: macData.pinSource || 'file', selectedSlots: slots });
      }
      return;
    }

    // Backward compat: single-Mac format
    const pin = normalizePin(parsed.pin);
    if (pin) {
      const macId = 'default-mac';
      const slots = Array.isArray(parsed.selectedSlots)
        ? parsed.selectedSlots.map((v) => (v ? String(v) : null)).slice(0, MAX_COMMANDS)
        : Array(MAX_COMMANDS).fill(null);
      while (slots.length < MAX_COMMANDS) slots.push(null);
      macConfigs.set(macId, { pin, pinSource: 'file', selectedSlots: slots });
    }
  } catch (err) {
    console.warn(`[RELAY] failed to load data: ${err.message}`);
  }
}

function saveData() {
  try {
    ensureDataDir();
    const macs = {};
    for (const [macId, config] of macConfigs.entries()) {
      macs[macId] = { pin: config.pin, pinSource: config.pinSource, selectedSlots: config.selectedSlots };
    }
    fs.writeFileSync(DATA_PATH, JSON.stringify({ macs, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[RELAY] failed to save data: ${err.message}`);
  }
}

// =========================================================
// Agent management
// =========================================================

function getOrCreateAgentState(macId) {
  let agent = agents.get(macId);
  if (!agent) {
    agent = {
      ws: null,
      deviceName: macId,
      rpcSeq: 1,
      pending: new Map(),
      appsCache: [],
      iconCache: new Map(),
      connectedAt: 0,
      lastSeenAt: 0
    };
    agents.set(macId, agent);
  }
  return agent;
}

function isAgentOnline(macId) {
  const agent = agents.get(macId);
  return !!agent?.ws && agent.ws.readyState === WebSocket.OPEN;
}

function closeAgentForMac(macId, reason = 'agent_disconnected') {
  const agent = agents.get(macId);
  if (!agent) return;
  for (const [id, pending] of agent.pending.entries()) {
    agent.pending.delete(id);
    pending.reject(new Error(reason));
  }
  if (agent.ws) {
    try { agent.ws.terminate(); } catch { /* ignore */ }
  }
  agent.ws = null;
}

function requestAgentRpc(macId, method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!isAgentOnline(macId)) {
      reject(new Error('agent_offline'));
      return;
    }
    const agent = agents.get(macId);
    const id = `${Date.now()}-${agent.rpcSeq++}`;
    const timer = setTimeout(() => {
      agent.pending.delete(id);
      reject(new Error(`rpc_timeout:${method}`));
    }, timeoutMs);
    agent.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); }
    });
    try {
      agent.ws.send(JSON.stringify({ type: 'rpc', id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      agent.pending.delete(id);
      reject(err);
    }
  });
}

async function refreshAppsFromAgent(macId, force = false) {
  if (!isAgentOnline(macId)) return;
  const agent = agents.get(macId);
  if (!agent) return;
  if (!force && agent.appsCache.length > 0) return;
  const list = await requestAgentRpc(macId, 'list_apps', { refresh: force });
  if (!Array.isArray(list)) return;
  agent.appsCache = list
    .map((item) => ({
      path: String(item.path || '').trim(),
      name: String(item.name || '').trim() || appPathToName(item.path)
    }))
    .filter((item) => item.path.endsWith('.app'))
    .slice(0, 2000);
}

// =========================================================
// Commands
// =========================================================

function buildCommands(macId) {
  const config = macConfigs.get(macId);
  if (!config) return [];
  const agent = agents.get(macId);
  const appsByPath = new Map((agent?.appsCache || []).map((a) => [a.path, a]));
  const commands = [];
  config.selectedSlots.forEach((slotPath, slotIndex) => {
    if (!slotPath) return;
    const app = appsByPath.get(slotPath);
    const name = app?.name || appPathToName(slotPath);
    const idHash = crypto.createHash('sha1').update(slotPath).digest('hex').slice(0, 10);
    commands.push({
      id: `open_${idHash}`,
      label: `${name}を開く`,
      enabled: true,
      ui: {
        requireHold: false,
        dangerous: false,
        slot: slotIndex,
        iconUrl: `/api/admin/icon?path=${encodeURIComponent(slotPath)}`
      },
      action: { type: 'open_app', path: slotPath, app: name }
    });
  });
  return commands.slice(0, MAX_COMMANDS);
}

async function executeCommand(macId, commandId) {
  const command = buildCommands(macId).find((c) => c.id === commandId);
  if (!command) return { ok: false, message: 'unknown_command' };
  if (!isAgentOnline(macId)) return { ok: false, message: 'agent_offline' };
  try {
    const result = await requestAgentRpc(macId, 'execute_command', { command }, 15000);
    return { ok: result?.ok !== false, message: result?.message || 'ok' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

function notifyCommandsUpdated(macId) {
  const commands = buildCommands(macId);
  for (const client of clientWss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client.macId !== macId) continue;
    client.send(JSON.stringify({ type: 'commands_updated', count: commands.length, at: Date.now() }));
  }
}

// =========================================================
// Auth
// =========================================================

function getPinAttemptKey(clientIp, deviceId = '') {
  return `${String(clientIp || 'unknown').trim()}::${normalizeDeviceId(deviceId) || 'shared'}`;
}

function getPinAttemptState(key) {
  const now = Date.now();
  const state = pinAttempts.get(key);
  if (!state) return { failCount: 0, lockUntil: 0 };
  if (state.lockUntil && now >= state.lockUntil) {
    pinAttempts.delete(key);
    return { failCount: 0, lockUntil: 0 };
  }
  return state;
}

function registerPinFailure(key) {
  const now = Date.now();
  const st = getPinAttemptState(key);
  const failCount = Number(st.failCount || 0) + 1;
  const lockUntil = failCount >= PIN_MAX_ATTEMPTS ? now + PIN_LOCK_MS : 0;
  const next = { failCount, lockUntil };
  pinAttempts.set(key, next);
  return next;
}

function clearPinFailures(key) {
  pinAttempts.delete(key);
}

function issueSessionToken(clientIp, deviceId, macId) {
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    clientIp,
    deviceId: normalizeDeviceId(deviceId),
    macId,
    createdAt: now,
    expiresAt: now + SESSION_TOKEN_TTL_MS
  });
  return { token, expiresAt: now + SESSION_TOKEN_TTL_MS };
}

function verifySessionToken(token, clientIp) {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, reason: 'missing_token' };
  const session = sessions.get(raw);
  if (!session) return { ok: false, reason: 'invalid_token' };
  if (Date.now() >= session.expiresAt) {
    sessions.delete(raw);
    return { ok: false, reason: 'token_expired' };
  }
  if (session.clientIp !== clientIp) return { ok: false, reason: 'token_ip_mismatch' };
  return { ok: true, token: raw, macId: session.macId, expiresAt: session.expiresAt };
}

function issueAdminToken(macId) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { macId, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
  return token;
}

function verifyAdminToken(req) {
  const auth = String(req.headers.authorization || '').trim();
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    adminSessions.delete(token);
    return null;
  }
  return session.macId;
}

// =========================================================
// HTTP helpers
// =========================================================

function normalizeClientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').trim();
  if (xf) return xf.split(',')[0].trim();
  return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch { reject(new Error('invalid json')); }
    });
    req.on('error', (err) => reject(err));
  });
}

function sendFallbackIcon(res, label) {
  const txt = (label || 'App').slice(0, 1).toUpperCase();
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#2b2d36"/><stop offset="1" stop-color="#12131a"/></linearGradient></defs><rect x="8" y="8" rx="42" ry="42" width="176" height="176" fill="url(#g)"/><text x="96" y="112" text-anchor="middle" font-size="88" fill="#f5f2ee" font-family="-apple-system,BlinkMacSystemFont,sans-serif">${txt}</text></svg>`;
  res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=120' });
  res.end(svg);
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (STATIC_ROUTE_ALIASES.has(pathname)) pathname = STATIC_ROUTE_ALIASES.get(pathname);
  const safePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!safePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(safePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// =========================================================
// API handlers
// =========================================================

async function handleApi(req, res, url) {
  if (url.pathname === '/api/runtime' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, debugUi: DEBUG_UI, env: process.env.NODE_ENV || 'development' });
    return true;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    const queryDeviceId = normalizeDeviceId(url.searchParams.get('deviceId') || '');
    if (queryDeviceId) {
      // 特定デバイスの接続確認のみ返す（mac-setup用）
      sendJson(res, 200, {
        ok: true,
        agentsOnline: isAgentOnline(queryDeviceId) ? [{ macId: queryDeviceId }] : [],
        now: new Date().toISOString()
      });
    } else {
      // デバイス詳細は返さず台数のみ
      const onlineCount = Array.from(agents.values())
        .filter((a) => a.ws && a.ws.readyState === WebSocket.OPEN).length;
      sendJson(res, 200, { ok: true, agentsOnline: onlineCount, now: new Date().toISOString() });
    }
    return true;
  }

  if (url.pathname === '/api/pairing' && req.method === 'GET') {
    const clientIp = normalizeClientIp(req);
    const deviceId = normalizeDeviceId(url.searchParams.get('deviceId'));
    const pinStr = String(url.searchParams.get('pin') || '').trim();

    let macId = null;
    let macConfig = null;

    if (pinStr) {
      macId = findMacByPin(pinStr);
      if (macId) macConfig = macConfigs.get(macId);
    }

    sendJson(res, 200, {
      ok: true,
      requirePin: REQUIRE_PIN,
      deviceId: deviceId || '',
      clientIp,
      pinPolicy: {
        minDigits: 4,
        maxDigits: 8,
        maxAttempts: PIN_MAX_ATTEMPTS,
        lockSeconds: Math.floor(PIN_LOCK_MS / 1000),
        sessionHours: Math.floor(SESSION_TOKEN_TTL_MS / (60 * 60 * 1000))
      },
      agentOnline: macId ? isAgentOnline(macId) : false,
      deviceName: macId ? (agents.get(macId)?.deviceName || macId) : null
    });
    return true;
  }

  if (url.pathname === '/api/commands' && req.method === 'GET') {
    const authHeader = String(req.headers.authorization || '').trim();
    let macId = null;
    if (authHeader.startsWith('Bearer ')) {
      const clientIp = normalizeClientIp(req);
      const result = verifySessionToken(authHeader.slice(7).trim(), clientIp);
      if (result.ok) macId = result.macId;
    }
    const commands = macId ? buildCommands(macId) : [];
    sendJson(res, 200, { ok: true, version: 1, commands });
    return true;
  }

  // ---- Admin: login (public) ----

  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    const clientIp = normalizeClientIp(req);
    const adminAttemptKey = getPinAttemptKey(clientIp, 'admin');
    const adminAttemptState = getPinAttemptState(adminAttemptKey);

    if (adminAttemptState.lockUntil && Date.now() < adminAttemptState.lockUntil) {
      sendJson(res, 429, {
        ok: false,
        message: 'too_many_attempts',
        retryAfterSeconds: Math.ceil((adminAttemptState.lockUntil - Date.now()) / 1000)
      });
      return true;
    }

    try {
      const body = await readJsonBody(req);
      const inputPin = normalizePin(body.pin);

      if (!REQUIRE_PIN) {
        // PIN無効モード: 最初に接続しているMacの管理者として発行
        const firstMacId = agents.keys().next().value || macConfigs.keys().next().value;
        if (!firstMacId) {
          sendJson(res, 503, { ok: false, message: 'no_mac_connected' });
          return true;
        }
        const token = issueAdminToken(firstMacId);
        sendJson(res, 200, { ok: true, token, macId: firstMacId, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS });
        return true;
      }

      const macId = findMacByPin(inputPin);
      if (!macId) {
        const next = registerPinFailure(adminAttemptKey);
        sendJson(res, 401, {
          ok: false,
          message: 'invalid_pin',
          retryAfterSeconds: next.lockUntil ? Math.ceil((next.lockUntil - Date.now()) / 1000) : 0
        });
        return true;
      }

      clearPinFailures(adminAttemptKey);
      const token = issueAdminToken(macId);
      const config = macConfigs.get(macId);
      sendJson(res, 200, {
        ok: true,
        token,
        macId,
        expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
        deviceName: agents.get(macId)?.deviceName || macId,
        weakPin: String(config?.pin || '').length <= 4
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: err.message });
    }
    return true;
  }

  // ---- Admin: authenticated routes ----

  if (url.pathname === '/api/admin/pin/rotate' && req.method === 'POST') {
    const macId = verifyAdminToken(req);
    if (!macId) { sendJson(res, 401, { ok: false, message: 'admin_auth_required' }); return true; }
    const pin = rotateMacPin(macId);
    if (!pin) { sendJson(res, 404, { ok: false, message: 'mac_not_found' }); return true; }
    sendJson(res, 200, { ok: true, pin, macId, deviceName: agents.get(macId)?.deviceName || macId });
    return true;
  }

  if (url.pathname === '/api/admin/state' && req.method === 'GET') {
    const macId = verifyAdminToken(req);
    if (!macId) { sendJson(res, 401, { ok: false, message: 'admin_auth_required' }); return true; }

    try { await refreshAppsFromAgent(macId, true); } catch { /* use cache */ }

    const config = getOrCreateMacConfig(macId);
    const agent = agents.get(macId);
    const selectedSet = new Set(config.selectedSlots.filter(Boolean));
    const apps = (agent?.appsCache || []).map((app) => ({
      path: app.path,
      name: app.name,
      iconUrl: `/api/admin/icon?path=${encodeURIComponent(app.path)}`,
      selected: selectedSet.has(app.path)
    }));

    sendJson(res, 200, {
      ok: true,
      macId,
      pin: config.pin,
      pinSource: config.pinSource,
      deviceName: agent?.deviceName || macId,
      pinLength: config.pin.length,
      pinPolicy: {
        minDigits: 4,
        maxDigits: 8,
        maxAttempts: PIN_MAX_ATTEMPTS,
        lockSeconds: Math.floor(PIN_LOCK_MS / 1000),
        sessionHours: Math.floor(SESSION_TOKEN_TTL_MS / (60 * 60 * 1000))
      },
      weakPin: config.pin.length <= 4,
      requirePin: REQUIRE_PIN,
      limits: { itemsPerPage: ITEMS_PER_PAGE, pages: MAX_PAGES, maxCommands: MAX_COMMANDS },
      selectedSlots: config.selectedSlots,
      selectedApps: config.selectedSlots.filter(Boolean),
      apps,
      agentOnline: isAgentOnline(macId)
    });
    return true;
  }

  if (url.pathname === '/api/admin/commands' && req.method === 'POST') {
    const macId = verifyAdminToken(req);
    if (!macId) { sendJson(res, 401, { ok: false, message: 'admin_auth_required' }); return true; }
    try {
      const body = await readJsonBody(req);
      const raw = Array.isArray(body.selectedSlots) ? body.selectedSlots : (Array.isArray(body.selectedApps) ? body.selectedApps : []);
      const next = raw.map((v) => (v ? String(v).trim() : null)).slice(0, MAX_COMMANDS);
      while (next.length < MAX_COMMANDS) next.push(null);
      const seen = new Set();
      const deduped = next.map((p) => {
        if (!p || seen.has(p)) return null;
        seen.add(p);
        return p;
      });
      const config = getOrCreateMacConfig(macId);
      config.selectedSlots = deduped;
      saveData();
      notifyCommandsUpdated(macId);
      sendJson(res, 200, {
        ok: true,
        selectedSlots: config.selectedSlots,
        selectedApps: config.selectedSlots.filter(Boolean),
        count: buildCommands(macId).length,
        maxCount: MAX_COMMANDS
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, message: err.message });
    }
    return true;
  }

  if (url.pathname === '/api/admin/icon' && req.method === 'GET') {
    const appPath = String(url.searchParams.get('path') || '').trim();
    if (!appPath) { sendFallbackIcon(res, '?'); return true; }

    // Find which agent owns this path
    let macId = null;
    for (const [id, agent] of agents.entries()) {
      if (agent.appsCache.some((a) => a.path === appPath)) { macId = id; break; }
    }
    if (!macId) { sendFallbackIcon(res, appPathToName(appPath)); return true; }

    const agent = agents.get(macId);
    const isKnownApp = (agent?.appsCache || []).some((a) => a.path === appPath);
    if (!isKnownApp) { sendFallbackIcon(res, appPathToName(appPath)); return true; }

    const cache = agent.iconCache.get(appPath);
    if (cache) {
      res.writeHead(200, { 'Content-Type': cache.mimeType || 'image/png', 'Cache-Control': 'public, max-age=600' });
      res.end(cache.buffer);
      return true;
    }
    try {
      const result = await requestAgentRpc(macId, 'get_icon', { path: appPath }, 15000);
      const base64 = String(result?.base64 || '');
      const mimeType = String(result?.mimeType || 'image/png');
      if (!base64) { sendFallbackIcon(res, appPathToName(appPath)); return true; }
      const buffer = Buffer.from(base64, 'base64');
      if (agent.iconCache.size > 500) agent.iconCache.clear();
      agent.iconCache.set(appPath, { mimeType, buffer });
      res.writeHead(200, { 'Content-Type': mimeType, 'Cache-Control': 'public, max-age=600' });
      res.end(buffer);
    } catch {
      sendFallbackIcon(res, appPathToName(appPath));
    }
    return true;
  }

  return false;
}

// =========================================================
// WebSocket: Agent
// =========================================================

function handleAgentConnection(ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const macId = normalizeDeviceId(url.searchParams.get('deviceId') || 'default-mac') || 'default-mac';

  let isAuthenticated = false;
  const authTimer = setTimeout(() => {
    if (!isAuthenticated) ws.close(1008, 'auth_timeout');
  }, 8000);

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (!isAuthenticated) {
      if (data.type !== 'agent_hello') return;
      const helloToken = String(data.token || '').trim();
      if (AGENT_TOKEN && helloToken !== AGENT_TOKEN) {
        clearTimeout(authTimer);
        ws.close(1008, 'invalid_agent_token');
        return;
      }
      clearTimeout(authTimer);
      isAuthenticated = true;

      closeAgentForMac(macId, 'replaced_by_new_agent');
      const agent = getOrCreateAgentState(macId);
      agent.ws = ws;
      agent.connectedAt = Date.now();
      agent.lastSeenAt = Date.now();
      agent.deviceName = normalizeDeviceName(data.deviceName || macId);
      getOrCreateMacConfig(macId);

      ws.send(JSON.stringify({ type: 'agent_ack', ok: true, macId }));
      console.log(`[AGENT] connected macId=${macId}`);
      return;
    }

    const agent = agents.get(macId);
    if (!agent) return;
    agent.lastSeenAt = Date.now();

    if (data.type === 'rpc_result') {
      const id = String(data.id || '');
      const pending = agent.pending.get(id);
      if (!pending) return;
      agent.pending.delete(id);
      if (data.ok) { pending.resolve(data.result); } else { pending.reject(new Error(data.error || 'rpc_failed')); }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    console.log(`[AGENT] disconnected macId=${macId}`);
    closeAgentForMac(macId, 'agent_closed');
  });
  ws.on('error', () => {
    clearTimeout(authTimer);
    closeAgentForMac(macId, 'agent_error');
  });
}

// =========================================================
// WebSocket: Client (iPhone)
// =========================================================

function handleClientAuth(ws, req, payload) {
  const clientIp = normalizeClientIp(req);
  const deviceId = normalizeDeviceId(payload?.deviceId);
  const attemptKey = getPinAttemptKey(clientIp, deviceId);

  if (!REQUIRE_PIN) {
    const firstMacId = agents.keys().next().value || macConfigs.keys().next().value;
    if (!firstMacId) {
      ws.send(JSON.stringify({ type: 'auth_result', ok: false, reason: 'no_mac_connected' }));
      return;
    }
    ws.isAuthed = true;
    ws.macId = firstMacId;
    const session = issueSessionToken(clientIp, deviceId, firstMacId);
    ws.send(JSON.stringify({ type: 'auth_result', ok: true, macId: firstMacId, token: session.token, expiresAt: session.expiresAt }));
    return;
  }

  if (payload.type === 'auth_token') {
    const result = verifySessionToken(payload.token, clientIp);
    if (!result.ok) {
      ws.send(JSON.stringify({ type: 'auth_result', ok: false, reason: result.reason }));
      return;
    }
    ws.isAuthed = true;
    ws.macId = result.macId;
    ws.send(JSON.stringify({ type: 'auth_result', ok: true, macId: result.macId, token: result.token, expiresAt: result.expiresAt }));
    return;
  }

  if (payload.type === 'auth') {
    const state = getPinAttemptState(attemptKey);
    if (state.lockUntil && Date.now() < state.lockUntil) {
      ws.send(JSON.stringify({
        type: 'auth_result', ok: false, reason: 'locked',
        retryAfterSeconds: Math.ceil((state.lockUntil - Date.now()) / 1000)
      }));
      return;
    }

    const inputPin = normalizePin(payload.pin);
    const macId = findMacByPin(inputPin);

    if (!macId) {
      const next = registerPinFailure(attemptKey);
      ws.send(JSON.stringify({
        type: 'auth_result', ok: false,
        reason: next.lockUntil ? 'locked' : 'invalid_pin',
        retryAfterSeconds: next.lockUntil ? Math.ceil((next.lockUntil - Date.now()) / 1000) : 0,
        attemptsRemainingBeforeLock: Math.max(0, PIN_MAX_ATTEMPTS - Number(next.failCount || 0))
      }));
      return;
    }

    clearPinFailures(attemptKey);
    ws.isAuthed = true;
    ws.macId = macId;
    const session = issueSessionToken(clientIp, deviceId, macId);
    ws.send(JSON.stringify({
      type: 'auth_result', ok: true, macId,
      token: session.token, expiresAt: session.expiresAt,
      deviceName: agents.get(macId)?.deviceName || macId
    }));
  }
}

function handleClientConnection(ws, req) {
  ws.isAuthed = false;
  ws.isAlive = true;
  ws.macId = null;

  if (REQUIRE_PIN) {
    ws.send(JSON.stringify({ type: 'auth_required', message: 'Authentication required', method: 'token_or_pin' }));
  }

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let payload;
    try { payload = JSON.parse(raw.toString()); } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (payload.type === 'auth' || payload.type === 'auth_token') {
      handleClientAuth(ws, req, payload);
      return;
    }

    if (REQUIRE_PIN && !ws.isAuthed) {
      ws.send(JSON.stringify({ type: 'auth_required', message: 'Authentication required', method: 'token_or_pin' }));
      return;
    }

    if (payload.type === 'run_command' || payload.type === 'command') {
      const commandId = String(payload.command || '').trim();
      const result = await executeCommand(ws.macId, commandId);
      ws.send(JSON.stringify({
        type: 'command_result',
        command: commandId,
        ok: result.ok,
        message: result.message,
        requestId: payload.requestId || null
      }));
    }
  });

  ws.on('close', () => {});
}

// =========================================================
// Server
// =========================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const handled = await handleApi(req, res, url).catch((err) => {
      sendJson(res, 500, { ok: false, message: err.message });
      return true;
    });
    if (!handled) sendJson(res, 404, { ok: false, message: 'not_found' });
    return;
  }
  if (url.pathname === '/mac-agent.js' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'mac-agent.js'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  serveStatic(req, res, url);
});

const clientWss = new WebSocketServer({ noServer: true });
const agentWss = new WebSocketServer({ noServer: true });

clientWss.on('connection', handleClientConnection);
agentWss.on('connection', handleAgentConnection);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/ws/agent') {
    agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, req));
    return;
  }
  clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit('connection', ws, req));
});

// Heartbeat + session cleanup
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions.entries()) { if (now >= s.expiresAt) sessions.delete(t); }
  for (const [t, s] of adminSessions.entries()) { if (now >= s.expiresAt) adminSessions.delete(t); }
  for (const [k, s] of pinAttempts.entries()) { if (s.lockUntil && now >= s.lockUntil) pinAttempts.delete(k); }
  clientWss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// =========================================================
// Startup
// =========================================================

loadData();

// Seed per-Mac PIN configs from env vars (for stateless deployments).
// These only apply when a macId has no existing config from the data file.
(function seedEnvPins() {
  function seedMac(macId, pin) {
    const id = normalizeDeviceId(macId);
    const p = normalizePin(pin);
    if (!id || !p) return;
    // Remove any other mac with the same PIN to prevent login conflicts
    for (const [otherId, cfg] of macConfigs.entries()) {
      if (otherId !== id && cfg.pin === p) macConfigs.delete(otherId);
    }
    // Always enforce env-var PIN — keep existing selectedSlots if already configured
    const existing = macConfigs.get(id);
    macConfigs.set(id, {
      pin: p,
      pinSource: 'env',
      selectedSlots: existing?.selectedSlots || Array(MAX_COMMANDS).fill(null)
    });
  }
  if (APP_PIN_SEED) {
    seedMac(DEFAULT_MAC_ID || 'default-mac', APP_PIN_SEED);
  }
  if (MAC_PINS_SEED) {
    for (const entry of MAC_PINS_SEED.split(',')) {
      const sep = entry.indexOf(':');
      if (sep < 1) continue;
      seedMac(entry.slice(0, sep).trim(), entry.slice(sep + 1).trim());
    }
  }
})();

server.listen(PORT, () => {
  console.log('========================================');
  console.log('Left Controller Relay Broker (multi-Mac)');
  console.log(`Port: ${PORT}`);
  console.log(`Agent token required: ${AGENT_TOKEN ? 'yes' : 'no'}`);
  if (!AGENT_TOKEN) {
    console.warn('[SECURITY] AGENT_TOKEN is not set. Set it in production.');
  }
  console.log(`PIN auth: ${REQUIRE_PIN ? 'ON' : 'OFF'}`);
  console.log(`Known Macs: ${macConfigs.size}`);
  for (const [macId, config] of macConfigs.entries()) {
    console.log(`  - ${macId}: PIN=${config.pin}`);
  }
  console.log(`Data path: ${DATA_PATH}`);
  console.log('========================================');
});
