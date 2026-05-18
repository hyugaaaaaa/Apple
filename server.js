'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const COMMANDS_CONFIG_PATH = path.join(__dirname, 'commands.json');
const ICON_SYNC_SCRIPT_PATH = path.join(__dirname, 'scripts', 'sync-app-icons.js');
const CERT_DIR = path.join(__dirname, 'certs');
const CERT_KEY_PATH = path.join(CERT_DIR, 'server.key');
const CERT_CRT_PATH = path.join(CERT_DIR, 'server.crt');
const CERT_CNF_PATH = path.join(CERT_DIR, 'openssl.cnf');
const LOG_DIR = path.join(__dirname, 'logs');
const AUDIT_LOG_PATH = path.join(LOG_DIR, 'audit.log');
const ICONS_DIR = path.join(PUBLIC_DIR, 'icons');

const APP_PIN = process.env.APP_PIN || '2580';
const REQUIRE_PIN = process.env.REQUIRE_PIN !== 'false';
const ALLOWED_CLIENTS_RAW = process.env.ALLOWED_CLIENTS || '';
const TLS_MODE = (process.env.TLS_MODE || 'off').toLowerCase(); // off | auto | on

const DEFAULT_ALLOWED_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16'
];

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

const DEFAULT_COMMANDS = {
  version: 1,
  commands: [
    {
      id: 'open_safari',
      label: 'Safariを開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'Safari' }
    },
    {
      id: 'open_finder',
      label: 'Finderを開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'Finder' }
    },
    {
      id: 'open_terminal',
      label: 'Terminalを開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'Terminal' }
    },
    {
      id: 'open_codex',
      label: 'Codexを開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'Codex' }
    }
  ]
};

const commandCache = {
  mtimeMs: 0,
  list: [],
  map: new Map()
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendAudit(entry) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...entry
  }) + '\n';

  fs.appendFile(AUDIT_LOG_PATH, line, (err) => {
    if (err) {
      console.error(`[AUDIT] failed to write log: ${err.message}`);
    }
  });
}

function runExec(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

function runAppleScript(script) {
  return runExec('osascript', ['-e', script]);
}

function getLocalIPv4List() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ interface: name, address: net.address });
      }
    }
  }

  return ips;
}

function buildOpenSslConfig(ipItems) {
  const dnsEntries = ['DNS.1 = localhost'];
  const ipEntries = ['IP.1 = 127.0.0.1'];

  ipItems.forEach((ip, idx) => {
    ipEntries.push(`IP.${idx + 2} = ${ip.address}`);
  });

  return [
    '[req]',
    'default_bits = 2048',
    'prompt = no',
    'default_md = sha256',
    'distinguished_name = req_distinguished_name',
    'x509_extensions = v3_req',
    '',
    '[req_distinguished_name]',
    'CN = localhost',
    '',
    '[v3_req]',
    'keyUsage = keyEncipherment, dataEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    ...dnsEntries,
    ...ipEntries
  ].join('\n');
}

function generateSelfSignedCerts() {
  ensureDir(CERT_DIR);

  const ips = getLocalIPv4List();
  const cnfText = buildOpenSslConfig(ips);
  fs.writeFileSync(CERT_CNF_PATH, cnfText, 'utf8');

  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '3650',
    '-keyout',
    CERT_KEY_PATH,
    '-out',
    CERT_CRT_PATH,
    '-subj',
    '/CN=localhost',
    '-config',
    CERT_CNF_PATH,
    '-extensions',
    'v3_req'
  ];

  const result = spawnSync('openssl', args, { encoding: 'utf8' });
  if (result.error) {
    throw new Error(`openssl invocation failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || 'openssl failed');
  }

  fs.chmodSync(CERT_KEY_PATH, 0o600);
}

function ensureTlsCertificates() {
  ensureDir(CERT_DIR);
  const hasKey = fs.existsSync(CERT_KEY_PATH);
  const hasCrt = fs.existsSync(CERT_CRT_PATH);

  if (hasKey && hasCrt) {
    return { enabled: true, generated: false };
  }

  try {
    generateSelfSignedCerts();
    return { enabled: true, generated: true };
  } catch (err) {
    console.warn(`[TLS] failed to generate self-signed cert: ${err.message}`);
    console.warn('[TLS] fallback to HTTP/WS mode.');
    return { enabled: false, generated: false };
  }
}

function resolveTlsState() {
  if (TLS_MODE === 'off') {
    return { enabled: false, generated: false, mode: 'off' };
  }

  if (TLS_MODE === 'auto') {
    const state = ensureTlsCertificates();
    return { ...state, mode: 'auto' };
  }

  if (TLS_MODE === 'on') {
    const state = ensureTlsCertificates();
    if (!state.enabled) {
      throw new Error('TLS_MODE=on but certificates are unavailable');
    }
    return { ...state, mode: 'on' };
  }

  console.warn(`[TLS] unknown TLS_MODE=${TLS_MODE}. fallback to off.`);
  return { enabled: false, generated: false, mode: 'off' };
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildActivateAndHideScript(appName) {
  const appLiteral = escapeAppleScriptString(appName);
  return `tell application "${appLiteral}" to activate
tell application "System Events"
  set theProcesses to every application process whose background only is false and name is not "${appLiteral}"
  repeat with p in theProcesses
    set visible of p to false
  end repeat
end tell`;
}

async function openAppAndHideOthers(appName) {
  // Launch first so the app is ready by the time System Events adjusts visibility.
  await runExec('open', ['-a', appName]);

  try {
    await runAppleScript(buildActivateAndHideScript(appName));
    return { ok: true, note: 'Activated + others hidden' };
  } catch (err) {
    // Fallback: keep app launch success even if hide operation is blocked.
    return {
      ok: true,
      note: `Launched (hide warning: ${err.message})`
    };
  }
}

function parseDesktopBounds(raw) {
  const nums = (raw || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));

  if (nums.length < 4) return null;

  const [left, top, right, bottom] = nums;
  if (right <= left || bottom <= top) return null;

  return { left, top, right, bottom };
}

async function getDesktopBounds() {
  const raw = await runAppleScript('tell application "Finder" to get bounds of window of desktop');
  const bounds = parseDesktopBounds(raw);
  if (!bounds) {
    throw new Error(`Failed to parse desktop bounds: ${raw}`);
  }
  return bounds;
}

function buildSnapScript(x, y, width, height) {
  return `
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  tell front window of frontProc
    set position to {${x}, ${y}}
    set size to {${width}, ${height}}
  end tell
end tell
`.trim();
}

async function snapFrontWindow(direction) {
  const { left, top, right, bottom } = await getDesktopBounds();
  const totalWidth = right - left;
  const totalHeight = bottom - top;
  const halfWidth = Math.floor(totalWidth / 2);

  const x = direction === 'left' ? left : left + halfWidth;
  const width = direction === 'left' ? halfWidth : totalWidth - halfWidth;

  await runAppleScript(buildSnapScript(x, top, width, totalHeight));
}

function normalizeClientIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;

  return ((nums[0] << 24) >>> 0)
    + ((nums[1] << 16) >>> 0)
    + ((nums[2] << 8) >>> 0)
    + nums[3];
}

function isIpInCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const ipInt = ipToInt(ip);
  const baseInt = ipToInt(base);

  if (ipInt === null || baseInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) {
    return false;
  }

  if (bits === 0) return true;

  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (ipInt & mask) === (baseInt & mask);
}

function parseAllowedRules(raw) {
  const rules = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (rules.length === 0) {
    return DEFAULT_ALLOWED_CIDRS;
  }
  return rules;
}

function isClientAllowed(ip, rules) {
  if (!ip) return false;

  return rules.some((rule) => {
    if (rule.includes('/')) {
      return isIpInCidr(ip, rule);
    }
    return ip === rule;
  });
}

function normalizeCommandConfig(rawItem, idx) {
  const item = rawItem || {};
  const id = String(item.id || '').trim();
  const label = String(item.label || '').trim();

  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`commands[${idx}] invalid id: ${id}`);
  }
  if (!label) {
    throw new Error(`commands[${idx}] missing label`);
  }

  const action = item.action || {};
  const type = String(action.type || '').trim();

  if (type === 'open_app') {
    if (!action.app || typeof action.app !== 'string') {
      throw new Error(`commands[${idx}] open_app requires action.app`);
    }
  } else if (type === 'open_url') {
    if (!action.url || typeof action.url !== 'string') {
      throw new Error(`commands[${idx}] open_url requires action.url`);
    }
  } else if (type === 'applescript') {
    if (!action.script || typeof action.script !== 'string') {
      throw new Error(`commands[${idx}] applescript requires action.script`);
    }
  } else if (type === 'window_snap') {
    if (action.direction !== 'left' && action.direction !== 'right') {
      throw new Error(`commands[${idx}] window_snap direction must be left|right`);
    }
  } else {
    throw new Error(`commands[${idx}] unsupported action.type: ${type}`);
  }

  const ui = item.ui || {};

  return {
    id,
    label,
    enabled: item.enabled !== false,
    ui: {
      requireHold: ui.requireHold === true,
      dangerous: ui.dangerous === true
    },
    action
  };
}

function parseCommandsConfig(rawText) {
  const parsed = JSON.parse(rawText);
  const list = Array.isArray(parsed) ? parsed : parsed.commands;

  if (!Array.isArray(list)) {
    throw new Error('commands.json must be an array or { commands: [] }');
  }

  const normalized = list.map((item, idx) => normalizeCommandConfig(item, idx));

  const idSet = new Set();
  for (const cmd of normalized) {
    if (idSet.has(cmd.id)) {
      throw new Error(`duplicate command id: ${cmd.id}`);
    }
    idSet.add(cmd.id);
  }

  return normalized;
}

function runIconSync() {
  if (!fs.existsSync(ICON_SYNC_SCRIPT_PATH)) {
    console.warn(`[ICON] sync script not found: ${ICON_SYNC_SCRIPT_PATH}`);
    return;
  }

  const result = spawnSync(
    process.execPath,
    [ICON_SYNC_SCRIPT_PATH, COMMANDS_CONFIG_PATH, ICONS_DIR],
    { encoding: 'utf8' }
  );

  if (result.error) {
    console.warn(`[ICON] sync error: ${result.error.message}`);
    return;
  }

  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim();
    console.warn(`[ICON] sync failed: ${msg || `exit ${result.status}`}`);
    return;
  }

  const msg = (result.stdout || '').trim();
  if (msg) {
    console.log(`[ICON] ${msg}`);
  }
}

function getCommandIconUrl(commandId) {
  const fileName = `${commandId}.png`;
  const absPath = path.join(ICONS_DIR, fileName);
  if (!fs.existsSync(absPath)) {
    return null;
  }

  const st = fs.statSync(absPath);
  const version = Math.floor(st.mtimeMs);
  return `/icons/${encodeURIComponent(fileName)}?v=${version}`;
}

function ensureDefaultCommandsConfig() {
  if (fs.existsSync(COMMANDS_CONFIG_PATH)) {
    return;
  }
  fs.writeFileSync(COMMANDS_CONFIG_PATH, JSON.stringify(DEFAULT_COMMANDS, null, 2), 'utf8');
}

function loadCommandsIfChanged(force = false) {
  ensureDefaultCommandsConfig();

  const st = fs.statSync(COMMANDS_CONFIG_PATH);
  if (!force && st.mtimeMs === commandCache.mtimeMs) {
    return;
  }

  const raw = fs.readFileSync(COMMANDS_CONFIG_PATH, 'utf8');
  const list = parseCommandsConfig(raw);
  const map = new Map();
  for (const cmd of list) {
    map.set(cmd.id, cmd);
  }

  commandCache.mtimeMs = st.mtimeMs;
  commandCache.list = list;
  commandCache.map = map;
  runIconSync();
}

function getClientCommandList() {
  loadCommandsIfChanged();
  return commandCache.list
    .filter((cmd) => cmd.enabled)
    .map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      ui: {
        ...cmd.ui,
        iconUrl: getCommandIconUrl(cmd.id)
      }
    }));
}

async function executeCommandById(commandId) {
  loadCommandsIfChanged();
  const cmd = commandCache.map.get(commandId);

  if (!cmd || !cmd.enabled) {
    return { ok: false, note: `Unknown command: ${commandId}` };
  }

  const action = cmd.action;

  if (action.type === 'open_app') {
    return openAppAndHideOthers(action.app);
  }
  if (action.type === 'open_url') {
    await runExec('open', [action.url]);
    return { ok: true, note: 'Opened URL' };
  }
  if (action.type === 'applescript') {
    await runAppleScript(action.script);
    return { ok: true, note: 'Executed' };
  }
  if (action.type === 'window_snap') {
    await snapFrontWindow(action.direction);
    return { ok: true, note: `Front window snapped ${action.direction}` };
  }

  return { ok: false, note: `Unsupported action: ${action.type}` };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveStaticFile(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/commands') {
    try {
      const commands = getClientCommandList();
      sendJson(res, 200, {
        ok: true,
        commands
      });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: err.message
      });
    }
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString()
    });
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') {
    pathname = '/index.html';
  }

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
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

ensureDir(LOG_DIR);
ensureDir(ICONS_DIR);
loadCommandsIfChanged(true);

const tlsState = resolveTlsState();
const tlsEnabled = tlsState.enabled;
const server = tlsEnabled
  ? https.createServer(
    {
      key: fs.readFileSync(CERT_KEY_PATH),
      cert: fs.readFileSync(CERT_CRT_PATH)
    },
    serveStaticFile
  )
  : http.createServer(serveStaticFile);

const wss = new WebSocketServer({ server });
const allowedRules = parseAllowedRules(ALLOWED_CLIENTS_RAW);

wss.on('connection', (ws, req) => {
  const normalizedIp = normalizeClientIp(req.socket.remoteAddress);
  const ua = req.headers['user-agent'] || '';

  if (!isClientAllowed(normalizedIp, allowedRules)) {
    ws.close(1008, 'Client IP not allowed');
    appendAudit({
      kind: 'ws_rejected',
      clientIp: normalizedIp,
      reason: 'ip_not_allowed',
      userAgent: ua
    });
    console.log(`[WS] rejected client: ${normalizedIp}`);
    return;
  }

  ws.isAlive = true;
  ws.isAuthed = !REQUIRE_PIN;

  if (ws._socket && ws._socket.setNoDelay) {
    ws._socket.setNoDelay(true);
  }

  console.log(`[WS] connected: ${normalizedIp}`);
  appendAudit({
    kind: 'ws_connected',
    clientIp: normalizedIp,
    userAgent: ua
  });

  if (REQUIRE_PIN) {
    ws.send(JSON.stringify({
      type: 'auth_required',
      message: 'PIN authentication required'
    }));
  }

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      appendAudit({
        kind: 'ws_invalid_json',
        clientIp: normalizedIp
      });
      return;
    }

    if (payload.type === 'auth') {
      if (!REQUIRE_PIN) {
        ws.isAuthed = true;
        ws.send(JSON.stringify({ type: 'auth_result', ok: true, message: 'Authentication bypassed' }));
        return;
      }

      const ok = payload.pin === APP_PIN;
      ws.isAuthed = ok;
      ws.send(JSON.stringify({
        type: 'auth_result',
        ok,
        message: ok ? 'Authenticated' : 'Invalid PIN'
      }));

      appendAudit({
        kind: 'auth_attempt',
        clientIp: normalizedIp,
        ok
      });
      return;
    }

    if (payload.type !== 'command') {
      ws.send(JSON.stringify({
        type: 'error',
        requestId: payload.requestId || null,
        message: 'Unsupported message type'
      }));
      return;
    }

    if (REQUIRE_PIN && !ws.isAuthed) {
      ws.send(JSON.stringify({
        type: 'error',
        requestId: payload.requestId || null,
        message: 'Unauthorized: enter PIN first'
      }));

      appendAudit({
        kind: 'command_denied',
        clientIp: normalizedIp,
        requestId: payload.requestId || null,
        command: payload.command,
        reason: 'not_authenticated'
      });
      return;
    }

    try {
      const result = await executeCommandById(payload.command);
      ws.send(JSON.stringify({
        type: 'command_result',
        ok: result.ok,
        requestId: payload.requestId || null,
        command: payload.command,
        message: result.note
      }));

      appendAudit({
        kind: 'command',
        clientIp: normalizedIp,
        requestId: payload.requestId || null,
        command: payload.command,
        ok: result.ok,
        note: result.note
      });
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'command_result',
        ok: false,
        requestId: payload.requestId || null,
        command: payload.command,
        message: err.message
      }));

      appendAudit({
        kind: 'command',
        clientIp: normalizedIp,
        requestId: payload.requestId || null,
        command: payload.command,
        ok: false,
        note: err.message
      });
    }
  });

  ws.on('close', () => {
    console.log(`[WS] disconnected: ${normalizedIp}`);
    appendAudit({
      kind: 'ws_disconnected',
      clientIp: normalizedIp
    });
  });
});

const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
});

server.listen(PORT, '0.0.0.0', () => {
  const webScheme = tlsEnabled ? 'https' : 'http';
  const wsScheme = tlsEnabled ? 'wss' : 'ws';

  console.log('========================================');
  console.log('iPhone Left Controller Server Started');
  console.log(`Local URL: ${webScheme}://localhost:${PORT}`);
  console.log(`WebSocket mode: ${wsScheme}`);

  if (tlsEnabled) {
    console.log(`[TLS] enabled mode=${tlsState.mode} (${tlsState.generated ? 'generated new self-signed cert' : 'existing cert loaded'})`);
  } else {
    console.log(`[TLS] disabled mode=${tlsState.mode}`);
  }

  if (REQUIRE_PIN) {
    console.log(`PIN auth: ON (${process.env.APP_PIN ? 'custom APP_PIN' : `default ${APP_PIN}`})`);
  } else {
    console.log('PIN auth: OFF (REQUIRE_PIN=false)');
  }

  console.log(`Allowed client rules: ${allowedRules.join(', ')}`);
  console.log(`Commands config: ${COMMANDS_CONFIG_PATH}`);
  console.log(`Audit log file: ${AUDIT_LOG_PATH}`);

  const ipList = getLocalIPv4List();
  if (ipList.length === 0) {
    console.log('No external IPv4 address found.');
  } else {
    console.log('Access from iPhone using one of these URLs:');
    for (const item of ipList) {
      console.log(`- [${item.interface}] ${webScheme}://${item.address}:${PORT}`);
    }
  }

  console.log('========================================');
});
