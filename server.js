'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = 8080;
const ITEMS_PER_PAGE = 8;
const MAX_CONTROLLER_PAGES = 3;
const MAX_CONTROLLER_COMMANDS = ITEMS_PER_PAGE * MAX_CONTROLLER_PAGES;
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
const ADMIN_ICONS_DIR = path.join(PUBLIC_DIR, 'admin-icons');
const PIN_STATE_PATH = path.join(__dirname, 'pin-state.json');

const APP_PIN_ENV = process.env.APP_PIN || '';
const REQUIRE_PIN = process.env.REQUIRE_PIN !== 'false';
const ALLOWED_CLIENTS_RAW = process.env.ALLOWED_CLIENTS || '';
const TLS_MODE = (process.env.TLS_MODE || 'off').toLowerCase(); // off | auto | on
const DEBUG_UI = process.env.DEBUG_UI
  ? process.env.DEBUG_UI === 'true'
  : process.env.NODE_ENV !== 'production';

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
    },
    {
      id: 'open_music',
      label: 'Musicを開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'Music' }
    },
    {
      id: 'open_mail',
      label: 'Mailを開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'Mail' }
    },
    {
      id: 'open_notes',
      label: 'メモを開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'Notes' }
    },
    {
      id: 'open_settings',
      label: '設定を開く',
      enabled: true,
      ui: { requireHold: false, dangerous: false },
      action: { type: 'open_app', app: 'System Settings' }
    }
  ]
};

const commandCache = {
  mtimeMs: 0,
  list: [],
  map: new Map()
};

const DEVICE_NAME = os.hostname();
let activePin = '2580';
let pinSource = 'default';
const pinAttemptMap = new Map();
const sessionTokenMap = new Map();
const SESSION_TOKEN_TTL_MS = Number(process.env.SESSION_TOKEN_TTL_MS || (12 * 60 * 60 * 1000));
const PIN_MAX_ATTEMPTS = Number(process.env.PIN_MAX_ATTEMPTS || 5);
const PIN_LOCK_MS = Number(process.env.PIN_LOCK_MS || (10 * 60 * 1000));

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizePin(pin) {
  const normalized = String(pin || '').trim();
  if (!/^\d{4,8}$/.test(normalized)) return '';
  return normalized;
}

function generatePin(digits = 4) {
  const max = 10 ** digits;
  const n = Math.floor(Math.random() * max);
  return String(n).padStart(digits, '0');
}

function writePinState(pin) {
  const payload = {
    pin,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(PIN_STATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function loadPinState() {
  if (fs.existsSync(PIN_STATE_PATH)) {
    try {
      const raw = fs.readFileSync(PIN_STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      const normalized = normalizePin(parsed.pin);
      if (normalized) {
        return { pin: normalized, source: 'file' };
      }
    } catch {
      // ignore invalid pin file and continue
    }
  }

  if (APP_PIN_ENV) {
    const normalized = normalizePin(APP_PIN_ENV);
    if (!normalized) {
      throw new Error('APP_PIN must be 4-8 digits');
    }
    return { pin: normalized, source: 'env' };
  }

  const generated = generatePin(6);
  writePinState(generated);
  return { pin: generated, source: 'generated' };
}

function rotatePin() {
  const nextPin = generatePin(6);
  writePinState(nextPin);
  activePin = nextPin;
  pinSource = 'file';
  sessionTokenMap.clear();
  pinAttemptMap.clear();
  return activePin;
}

function getPinAttemptState(clientIp) {
  const now = Date.now();
  const state = pinAttemptMap.get(clientIp);
  if (!state) {
    return { failCount: 0, lockUntil: 0 };
  }
  if (state.lockUntil && now >= state.lockUntil) {
    pinAttemptMap.delete(clientIp);
    return { failCount: 0, lockUntil: 0 };
  }
  return state;
}

function registerPinFailure(clientIp) {
  const now = Date.now();
  const state = getPinAttemptState(clientIp);
  const failCount = Number(state.failCount || 0) + 1;
  const lockUntil = failCount >= PIN_MAX_ATTEMPTS ? now + PIN_LOCK_MS : 0;
  const nextState = { failCount, lockUntil };
  pinAttemptMap.set(clientIp, nextState);
  return nextState;
}

function clearPinFailures(clientIp) {
  pinAttemptMap.delete(clientIp);
}

function issueSessionToken(clientIp, userAgent) {
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('hex');
  sessionTokenMap.set(token, {
    clientIp,
    userAgent: String(userAgent || ''),
    createdAt: now,
    expiresAt: now + SESSION_TOKEN_TTL_MS
  });
  return {
    token,
    expiresAt: now + SESSION_TOKEN_TTL_MS
  };
}

function verifySessionToken(token, clientIp) {
  const raw = String(token || '').trim();
  if (!raw) {
    return { ok: false, reason: 'missing_token' };
  }
  const session = sessionTokenMap.get(raw);
  if (!session) {
    return { ok: false, reason: 'invalid_token' };
  }
  if (Date.now() >= session.expiresAt) {
    sessionTokenMap.delete(raw);
    return { ok: false, reason: 'token_expired' };
  }
  if (session.clientIp !== clientIp) {
    return { ok: false, reason: 'token_ip_mismatch' };
  }
  return { ok: true, token: raw, expiresAt: session.expiresAt };
}

function cleanupAuthStates() {
  const now = Date.now();
  for (const [key, value] of sessionTokenMap.entries()) {
    if (!value || now >= value.expiresAt) {
      sessionTokenMap.delete(key);
    }
  }
  for (const [key, value] of pinAttemptMap.entries()) {
    if (!value) {
      pinAttemptMap.delete(key);
      continue;
    }
    if (value.lockUntil && now >= value.lockUntil) {
      pinAttemptMap.delete(key);
    }
  }
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
delay 0.12
tell application "System Events"
  set theProcesses to every application process whose background only is false and frontmost is false
  repeat with p in theProcesses
    try
      set visible of p to false
    end try
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
  const slot = Number(ui.slot);
  const hasValidSlot = Number.isInteger(slot) && slot >= 0 && slot < MAX_CONTROLLER_COMMANDS;

  return {
    id,
    label,
    enabled: item.enabled !== false,
    ui: {
      requireHold: ui.requireHold === true,
      dangerous: ui.dangerous === true,
      slot: hasValidSlot ? slot : undefined
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

function stripAppExtension(name) {
  if (String(name || '').toLowerCase().endsWith('.app')) {
    return String(name).slice(0, -4);
  }
  return String(name || '');
}

function simpleHashHex(input) {
  let hash = 0x811c9dc5;
  const str = String(input || '');
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toCommandId(appName, bundlePath, usedIds) {
  const baseSlug = String(appName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const base = baseSlug
    ? `open_${baseSlug}`
    : `open_app_${simpleHashHex(bundlePath).slice(0, 6)}`;

  let id = base;
  let seq = 2;
  while (usedIds.has(id)) {
    id = `${base}_${seq}`;
    seq += 1;
  }
  usedIds.add(id);
  return id;
}

function walkAppBundles(rootDir, maxDepth = 4) {
  const out = [];

  function walk(currentDir, depth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.')) continue;

      const fullPath = path.join(currentDir, ent.name);
      if (ent.name.toLowerCase().endsWith('.app')) {
        out.push(fullPath);
        continue;
      }

      walk(fullPath, depth + 1);
    }
  }

  walk(rootDir, 0);
  return out;
}

function listInstalledApplications() {
  const roots = [
    '/Applications',
    '/System/Applications',
    '/System/Library/CoreServices',
    '/System/Cryptexes/App/System/Applications',
    path.join(os.homedir(), 'Applications')
  ];

  const seen = new Set();
  const apps = [];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const bundles = walkAppBundles(root, 4);
    for (const rawPath of bundles) {
      let bundlePath = rawPath;
      try {
        bundlePath = fs.realpathSync(rawPath);
      } catch {
        bundlePath = rawPath;
      }
      if (seen.has(bundlePath)) continue;
      seen.add(bundlePath);

      const appName = stripAppExtension(path.basename(bundlePath));
      apps.push({ appName, bundlePath });
    }
  }

  apps.sort((a, b) => {
    const byName = a.appName.localeCompare(b.appName, 'ja');
    if (byName !== 0) return byName;
    return a.bundlePath.localeCompare(b.bundlePath, 'ja');
  });

  return apps;
}

function runTextSync(bin, args) {
  const ret = spawnSync(bin, args, { encoding: 'utf8' });
  if (ret.error || ret.status !== 0) return '';
  return (ret.stdout || '').trim();
}

function plistReadSync(plistPath, keyPath) {
  return runTextSync('/usr/libexec/PlistBuddy', ['-c', `Print ${keyPath}`, plistPath]);
}

function resolveIconSourceFromBundle(appBundlePath) {
  const plistPath = path.join(appBundlePath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) return '';

  const candidates = [];
  const v1 = plistReadSync(plistPath, ':CFBundleIconFile');
  const v2 = plistReadSync(plistPath, ':CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFile');
  const v3 = plistReadSync(plistPath, ':CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:0');

  [v1, v2, v3].forEach((v) => {
    if (!v) return;
    candidates.push(v);
    if (!path.extname(v)) candidates.push(`${v}.icns`);
    if (!path.extname(v)) candidates.push(`${v}.png`);
  });

  const resourcesDir = path.join(appBundlePath, 'Contents', 'Resources');
  if (!fs.existsSync(resourcesDir)) return '';

  for (const name of candidates) {
    const p = path.join(resourcesDir, name);
    if (fs.existsSync(p)) return p;
  }

  const fallbackIcns = fs.readdirSync(resourcesDir)
    .filter((f) => f.toLowerCase().endsWith('.icns'))
    .sort();
  if (fallbackIcns.length > 0) {
    return path.join(resourcesDir, fallbackIcns[0]);
  }
  return '';
}

function adminIconFileName(bundlePath) {
  const hash = simpleHashHex(bundlePath);
  const base = stripAppExtension(path.basename(bundlePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return `${hash}_${base || 'app'}.png`;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appInitials(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return 'APP';
  const words = normalized.split(/[^A-Za-z0-9\u3040-\u30ff\u3400-\u9fbf]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0].charAt(0)}${words[1].charAt(0)}`.toUpperCase();
  }
  return normalized.slice(0, 2).toUpperCase();
}

function buildFallbackAdminIconSvg(appName) {
  const initials = escapeXml(appInitials(appName));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="${escapeXml(appName || 'App')}">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2f3542" />
      <stop offset="100%" stop-color="#11141a" />
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)" />
  <rect x="8" y="8" width="240" height="240" rx="56" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2" />
  <text x="128" y="144" text-anchor="middle" font-family="SF Pro Display, Avenir Next, sans-serif" font-size="76" font-weight="700" fill="#f4f6fb">${initials}</text>
</svg>`;
}

function sendFallbackAdminIcon(res, appName) {
  const svg = buildFallbackAdminIconSvg(appName);
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=3600'
  });
  res.end(svg);
}

function ensureAdminIcon(bundlePath) {
  ensureDir(ADMIN_ICONS_DIR);
  const fileName = adminIconFileName(bundlePath);
  const outPath = path.join(ADMIN_ICONS_DIR, fileName);
  if (fs.existsSync(outPath)) return outPath;

  const iconSrc = resolveIconSourceFromBundle(bundlePath);
  if (!iconSrc) return '';

  const ret = spawnSync('sips', ['-s', 'format', 'png', iconSrc, '--out', outPath], { encoding: 'utf8' });
  if (ret.error || ret.status !== 0 || !fs.existsSync(outPath)) {
    return '';
  }
  return outPath;
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
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
    .slice(0, MAX_CONTROLLER_COMMANDS)
    .map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      ui: {
        ...cmd.ui,
        iconUrl: getCommandIconUrl(cmd.id)
      }
    }));
}

function buildCommandsConfigFromSelectedApps(selectedApps) {
  const selectedList = (Array.isArray(selectedApps) ? selectedApps : [])
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, MAX_CONTROLLER_COMMANDS);
  const installed = listInstalledApplications();
  const byPath = new Map(installed.map((item) => [item.bundlePath, item]));
  const seenPaths = new Set();
  const ordered = [];
  for (const bundlePath of selectedList) {
    if (seenPaths.has(bundlePath)) continue;
    const item = byPath.get(bundlePath);
    if (!item) continue;
    seenPaths.add(bundlePath);
    ordered.push(item);
  }
  const usedIds = new Set();

  const commands = ordered.map((item, index) => ({
      id: toCommandId(item.appName, item.bundlePath, usedIds),
      label: `${item.appName}を開く`,
      enabled: true,
      ui: { requireHold: false, dangerous: false, slot: index },
      action: { type: 'open_app', app: item.appName }
    }));

  return {
    version: 1,
    commands
  };
}

function buildCommandsConfigFromSelectedSlots(selectedSlots) {
  const slots = Array.isArray(selectedSlots) ? selectedSlots.slice(0, MAX_CONTROLLER_COMMANDS) : [];
  const installed = listInstalledApplications();
  const byPath = new Map(installed.map((item) => [item.bundlePath, item]));
  const usedIds = new Set();
  const usedPaths = new Set();
  const commands = [];

  for (let slot = 0; slot < MAX_CONTROLLER_COMMANDS; slot += 1) {
    const rawPath = slots[slot];
    const bundlePath = rawPath ? String(rawPath).trim() : '';
    if (!bundlePath) continue;
    if (usedPaths.has(bundlePath)) continue;
    const item = byPath.get(bundlePath);
    if (!item) continue;
    usedPaths.add(bundlePath);
    commands.push({
      id: toCommandId(item.appName, item.bundlePath, usedIds),
      label: `${item.appName}を開く`,
      enabled: true,
      ui: { requireHold: false, dangerous: false, slot },
      action: { type: 'open_app', app: item.appName }
    });
  }

  return {
    version: 1,
    commands
  };
}

function getAdminState() {
  loadCommandsIfChanged();
  const installed = listInstalledApplications();
  const byName = new Map();
  installed.forEach((item) => {
    if (!byName.has(item.appName)) {
      byName.set(item.appName, item.bundlePath);
    }
  });
  const selectedApps = [];
  const selectedSlots = Array(MAX_CONTROLLER_COMMANDS).fill(null);
  const selectedPathSet = new Set();
  commandCache.list
    .filter((cmd) => cmd.enabled && cmd.action && cmd.action.type === 'open_app')
    .forEach((cmd, idx) => {
      const appName = String(cmd.action.app || '').trim();
      const pathHit = byName.get(appName);
      if (!pathHit || selectedPathSet.has(pathHit)) return;
      selectedPathSet.add(pathHit);
      selectedApps.push(pathHit);
      const slot = Number(cmd.ui && cmd.ui.slot);
      if (Number.isInteger(slot) && slot >= 0 && slot < MAX_CONTROLLER_COMMANDS) {
        selectedSlots[slot] = pathHit;
        return;
      }
      for (let i = 0; i < MAX_CONTROLLER_COMMANDS; i += 1) {
        if (!selectedSlots[i]) {
          selectedSlots[i] = pathHit;
          break;
        }
      }
    });

  return {
    pin: activePin,
    pinSource,
    deviceName: DEVICE_NAME,
    pinLength: String(activePin || '').length,
    pinPolicy: {
      minDigits: 6,
      maxDigits: 8,
      maxAttempts: PIN_MAX_ATTEMPTS,
      lockSeconds: Math.floor(PIN_LOCK_MS / 1000),
      sessionHours: Math.floor(SESSION_TOKEN_TTL_MS / (60 * 60 * 1000))
    },
    weakPin: String(activePin || '').length < 6,
    requirePin: REQUIRE_PIN,
    limits: {
      itemsPerPage: ITEMS_PER_PAGE,
      pages: MAX_CONTROLLER_PAGES,
      maxCommands: MAX_CONTROLLER_COMMANDS
    },
    selectedSlots,
    selectedApps,
    apps: installed.map((item) => ({
      path: item.bundlePath,
      name: item.appName,
      iconUrl: `/api/admin/icon?path=${encodeURIComponent(item.bundlePath)}`,
      selected: selectedPathSet.has(item.bundlePath)
    }))
  };
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

  if (url.pathname === '/api/admin/state' && req.method === 'GET') {
    try {
      sendJson(res, 200, {
        ok: true,
        ...getAdminState()
      });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: err.message
      });
    }
    return;
  }

  if (url.pathname === '/api/pairing' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      requirePin: REQUIRE_PIN,
      pin: activePin,
      pinSource,
      deviceName: DEVICE_NAME,
      pinLength: String(activePin || '').length,
      pinPolicy: {
        minDigits: 6,
        maxDigits: 8,
        maxAttempts: PIN_MAX_ATTEMPTS,
        lockSeconds: Math.floor(PIN_LOCK_MS / 1000),
        sessionHours: Math.floor(SESSION_TOKEN_TTL_MS / (60 * 60 * 1000))
      },
      weakPin: String(activePin || '').length < 6
    });
    return;
  }

  if (url.pathname === '/api/runtime' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      debugUi: DEBUG_UI,
      env: process.env.NODE_ENV || 'development'
    });
    return;
  }

  if (url.pathname === '/api/admin/pin/rotate' && req.method === 'POST') {
    try {
      const nextPin = rotatePin();
      sendJson(res, 200, {
        ok: true,
        pin: nextPin,
        pinSource,
        deviceName: DEVICE_NAME,
        requirePin: REQUIRE_PIN
      });
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        message: err.message
      });
    }
    return;
  }

  if (url.pathname === '/api/admin/icon' && req.method === 'GET') {
    try {
      const appPath = String(url.searchParams.get('path') || '').trim();
      if (!appPath) {
        sendJson(res, 400, { ok: false, message: 'path is required' });
        return;
      }

      const installed = listInstalledApplications();
      const found = installed.find((item) => item.bundlePath === appPath);
      if (!found) {
        sendJson(res, 404, { ok: false, message: 'app not found' });
        return;
      }

      const iconPath = ensureAdminIcon(found.bundlePath);
      if (!iconPath) {
        sendFallbackAdminIcon(res, found.appName);
        return;
      }

      fs.readFile(iconPath, (err, data) => {
        if (err) {
          sendFallbackAdminIcon(res, found.appName);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(data);
      });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        message: err.message
      });
    }
    return;
  }

  if (url.pathname === '/api/admin/commands' && req.method === 'POST') {
    readJsonBody(req)
      .then((body) => {
        const selectedApps = Array.isArray(body.selectedApps) ? body.selectedApps : [];
        const selectedSlots = Array.isArray(body.selectedSlots) ? body.selectedSlots : null;
        const limitedSelectedApps = selectedApps.slice(0, MAX_CONTROLLER_COMMANDS);
        const limitedSelectedSlots = selectedSlots ? selectedSlots.slice(0, MAX_CONTROLLER_COMMANDS) : null;
        const nextConfig = limitedSelectedSlots
          ? buildCommandsConfigFromSelectedSlots(limitedSelectedSlots)
          : buildCommandsConfigFromSelectedApps(limitedSelectedApps);
        fs.writeFileSync(COMMANDS_CONFIG_PATH, JSON.stringify(nextConfig, null, 2), 'utf8');
        loadCommandsIfChanged(true);

        wss.clients.forEach((client) => {
          if (client.readyState !== 1) return;
          client.send(JSON.stringify({
            type: 'commands_updated',
            count: nextConfig.commands.length,
            at: Date.now()
          }));
        });

        sendJson(res, 200, {
          ok: true,
          selectedApps: limitedSelectedApps,
          selectedSlots: limitedSelectedSlots,
          count: nextConfig.commands.length,
          maxCount: MAX_CONTROLLER_COMMANDS
        });
      })
      .catch((err) => {
        sendJson(res, 400, {
          ok: false,
          message: err.message
        });
      });
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
ensureDir(ADMIN_ICONS_DIR);
const pinState = loadPinState();
activePin = pinState.pin;
pinSource = pinState.source;
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
      message: 'Authentication required',
      method: 'token_or_pin'
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

    if (payload.type === 'auth_token') {
      const verified = verifySessionToken(payload.token, normalizedIp);
      const ok = verified.ok === true;
      ws.isAuthed = ok;
      ws.send(JSON.stringify({
        type: 'auth_result',
        ok,
        reason: ok ? 'token_ok' : verified.reason,
        message: ok ? 'Authenticated via token' : 'Token authentication failed'
      }));
      appendAudit({
        kind: 'auth_token_attempt',
        clientIp: normalizedIp,
        ok,
        reason: ok ? 'token_ok' : verified.reason
      });
      return;
    }

    if (payload.type === 'auth') {
      if (!REQUIRE_PIN) {
        const issued = issueSessionToken(normalizedIp, ua);
        ws.isAuthed = true;
        ws.send(JSON.stringify({
          type: 'auth_result',
          ok: true,
          message: 'Authentication bypassed',
          token: issued.token,
          expiresAt: issued.expiresAt
        }));
        return;
      }

      const state = getPinAttemptState(normalizedIp);
      if (state.lockUntil && Date.now() < state.lockUntil) {
        const retryAfterSeconds = Math.max(1, Math.ceil((state.lockUntil - Date.now()) / 1000));
        ws.isAuthed = false;
        ws.send(JSON.stringify({
          type: 'auth_result',
          ok: false,
          reason: 'locked',
          message: 'Too many failed attempts',
          retryAfterSeconds
        }));
        appendAudit({
          kind: 'auth_attempt_blocked',
          clientIp: normalizedIp,
          reason: 'locked',
          retryAfterSeconds
        });
        return;
      }

      const ok = String(payload.pin || '').trim() === activePin;
      ws.isAuthed = ok;
      let issued = null;
      if (ok) {
        clearPinFailures(normalizedIp);
        issued = issueSessionToken(normalizedIp, ua);
      } else {
        registerPinFailure(normalizedIp);
      }

      const lockState = getPinAttemptState(normalizedIp);
      const retryAfterSeconds = lockState.lockUntil && Date.now() < lockState.lockUntil
        ? Math.max(1, Math.ceil((lockState.lockUntil - Date.now()) / 1000))
        : 0;

      ws.send(JSON.stringify({
        type: 'auth_result',
        ok,
        reason: ok ? 'pin_ok' : 'invalid_pin',
        message: ok ? 'Authenticated' : 'Invalid PIN',
        token: issued ? issued.token : undefined,
        expiresAt: issued ? issued.expiresAt : undefined,
        remainingAttempts: ok ? PIN_MAX_ATTEMPTS : Math.max(0, PIN_MAX_ATTEMPTS - Number(lockState.failCount || 0)),
        retryAfterSeconds
      }));

      appendAudit({
        kind: 'auth_attempt',
        clientIp: normalizedIp,
        ok,
        remainingAttempts: ok ? PIN_MAX_ATTEMPTS : Math.max(0, PIN_MAX_ATTEMPTS - Number(lockState.failCount || 0))
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
  cleanupAuthStates();
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
    console.log(`PIN auth: ON (${pinSource})`);
    console.log(`Pairing PIN: ${activePin}`);
    console.log(`Device name: ${DEVICE_NAME}`);
    console.log(`Auth policy: maxAttempts=${PIN_MAX_ATTEMPTS}, lock=${Math.floor(PIN_LOCK_MS / 1000)}s, tokenTTL=${Math.floor(SESSION_TOKEN_TTL_MS / (60 * 60 * 1000))}h`);
    if (String(activePin || '').length < 6) {
      console.warn('[SECURITY] PIN is less than 6 digits. Set 6-8 digits for production.');
    }
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
      console.log(`  Admin: ${webScheme}://${item.address}:${PORT}/admin.html`);
    }
  }

  console.log('========================================');
});
