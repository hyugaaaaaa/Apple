'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { WebSocket } = require('ws');

const BROKER_WS_URL = process.env.BROKER_WS_URL || 'ws://localhost:8080/ws/agent';
const DEVICE_ID = process.env.DEVICE_ID || os.hostname();
const DEVICE_NAME = process.env.DEVICE_NAME || os.hostname();
const AGENT_TOKEN = String(process.env.AGENT_TOKEN || '').trim();

const APP_SCAN_LIMIT = Number(process.env.APP_SCAN_LIMIT || 2000);
const ICON_SIZE = Number(process.env.ICON_SIZE || 512);
const APP_SCAN_CACHE_MS = Number(process.env.APP_SCAN_CACHE_MS || (2 * 60 * 1000));

let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let pingTimer = null;

const appCache = {
  updatedAt: 0,
  list: []
};
const iconCache = new Map();

function runExec(binary, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: timeoutMs > 0 ? timeoutMs : undefined
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || '').trim()));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function appPathToName(appPath) {
  const name = path.basename(String(appPath || ''), '.app').trim();
  return name || 'App';
}

async function listInstalledApps() {
  const now = Date.now();
  if (now - appCache.updatedAt < APP_SCAN_CACHE_MS && appCache.list.length > 0) {
    return appCache.list;
  }

  let appPaths = [];

  try {
    const out = await runExec('/usr/bin/mdfind', ['kMDItemContentTypeTree == "com.apple.application-bundle"']);
    appPaths = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.app'));
  } catch {
    // fallback below
  }

  if (appPaths.length === 0) {
    const roots = [
      '/Applications',
      '/System/Applications',
      '/System/Library/CoreServices'
    ];

    const found = [];
    for (const root of roots) {
      try {
        const out = await runExec('/usr/bin/find', [root, '-type', 'd', '-name', '*.app']);
        found.push(...out.split('\n').map((line) => line.trim()).filter(Boolean));
      } catch {
        // ignore each root error
      }
    }
    appPaths = found;
  }

  const uniq = Array.from(new Set(appPaths))
    .filter((p) => p.includes('/Applications/') || p.includes('/CoreServices/'))
    .sort((a, b) => appPathToName(a).localeCompare(appPathToName(b), 'ja'))
    .slice(0, APP_SCAN_LIMIT);

  const list = uniq.map((p) => ({ path: p, name: appPathToName(p) }));
  appCache.updatedAt = Date.now();
  appCache.list = list;
  return list;
}

async function extractIconPngBase64(appPath) {
  const cached = iconCache.get(appPath);
  if (cached) return cached;

  async function extractViaQuickLook(tempDir) {
    await runExec('/usr/bin/qlmanage', ['-t', '-s', String(ICON_SIZE), '-o', tempDir, appPath], { timeoutMs: 1800 });
    const entries = fs.readdirSync(tempDir).filter((name) => name.endsWith('.png'));
    if (entries.length === 0) {
      throw new Error('icon_not_generated_by_quicklook');
    }
    entries.sort();
    return path.join(tempDir, entries[0]);
  }

  async function findIcnsCandidates() {
    const resourcesDir = path.join(appPath, 'Contents', 'Resources');
    if (!fs.existsSync(resourcesDir)) return [];

    const out = await runExec('/usr/bin/find', [resourcesDir, '-type', 'f', '-name', '*.icns']);
    const files = out.split('\n').map((line) => line.trim()).filter(Boolean);
    if (files.length === 0) return [];

    return files
      .map((file) => {
        let score = 0;
        const base = path.basename(file).toLowerCase();
        if (base.includes('appicon')) score += 30;
        if (base.includes('icon')) score += 10;
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
        score += Math.min(50, Math.floor(size / 10000));
        return { file, score, size };
      })
      .sort((a, b) => (b.score - a.score) || (b.size - a.size))
      .map((v) => v.file);
  }

  async function extractViaIcns(tempDir) {
    const icnsList = await findIcnsCandidates();
    if (icnsList.length === 0) {
      throw new Error('icns_not_found');
    }

    const outputPath = path.join(tempDir, 'icon.png');
    let lastError = null;
    for (const icnsPath of icnsList.slice(0, 8)) {
      try {
        await runExec('/usr/bin/sips', [
          '-s', 'format', 'png',
          '-Z', String(ICON_SIZE),
          icnsPath,
          '--out', outputPath
        ]);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          return outputPath;
        }
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('icns_convert_failed');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leftctl-icon-'));
  try {
    let iconPath = null;

    try {
      iconPath = await extractViaQuickLook(tempDir);
    } catch (quicklookErr) {
      try {
        iconPath = await extractViaIcns(tempDir);
      } catch (icnsErr) {
        throw new Error(`icon_extract_failed: quicklook=${quicklookErr.message}; icns=${icnsErr.message}`);
      }
    }
    const buf = fs.readFileSync(iconPath);
    const base64 = buf.toString('base64');

    const result = {
      mimeType: 'image/png',
      base64
    };

    if (iconCache.size > 500) {
      iconCache.clear();
    }
    iconCache.set(appPath, result);
    return result;
  } catch (err) {
    console.warn(`[AGENT] icon extract failed: ${appPath} -> ${err.message}`);
    throw err;
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function minimizeOtherWindows(targetAppPath) {
  // Swift製ヘルパーで他アプリを最小化（AX API使用、自動化許可ダイアログ不要）
  const helperPath = path.join(__dirname, 'leftctl-minimize');
  if (fs.existsSync(helperPath) && targetAppPath) {
    await runExec(helperPath, ['--others', targetAppPath], { timeoutMs: 8000 });
  }
}

async function executeOpenApp(command) {
  const action = command?.action || {};
  const appPath = String(action.path || '').trim();
  const appName = String(action.app || '').trim();

  if (!appPath && !appName) {
    throw new Error('missing_app_target');
  }

  // minimize はバックグラウンドで並列実行し、open の完了を待たない
  if (appPath) minimizeOtherWindows(appPath).catch(() => {});

  if (appPath) {
    await runExec('/usr/bin/open', ['-a', appPath]);
  } else {
    await runExec('/usr/bin/open', ['-a', appName]);
  }

  return {
    ok: true,
    message: `opened:${appPath || appName}`
  };
}

async function executeMinimizeApp(command) {
  const action = command?.action || {};
  const appPath = String(action.path || '').trim();
  const appName = String(action.app || '').trim();

  if (!appPath && !appName) {
    throw new Error('missing_app_target');
  }

  // Swift製CLIツールでAX APIを使って最小化（Electronアプリを含む全アプリ対応）
  const helperPath = path.join(__dirname, 'leftctl-minimize');
  if (fs.existsSync(helperPath) && appPath) {
    try {
      await runExec(helperPath, [appPath], { timeoutMs: 8000 });
      return { ok: true, message: `minimized:${appPath}` };
    } catch {
      // フォールバック: osascript（ネイティブアプリ用）
    }
  }

  // osascript フォールバック（ネイティブAppleScriptアプリ用）
  const target = appPath
    ? appPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    : appName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = [
    `tell application "${target}"`,
    '  repeat with w in windows',
    '    try',
    '      set miniaturized of w to true',
    '    end try',
    '  end repeat',
    'end tell'
  ].join('\n');

  const tmpFile = os.tmpdir() + '/leftctl-minimize-app.applescript';
  fs.writeFileSync(tmpFile, script, 'utf8');
  try {
    await runExec('/usr/bin/osascript', [tmpFile], { timeoutMs: 8000 });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }

  return { ok: true, message: `minimized:${appPath || appName}` };
}

async function handleRpc(method, params) {
  if (method === 'list_apps') {
    const refresh = !!params?.refresh;
    if (refresh) {
      appCache.updatedAt = 0;
    }
    return listInstalledApps();
  }

  if (method === 'get_icon') {
    const appPath = String(params?.path || '').trim();
    if (!appPath) {
      throw new Error('missing_path');
    }
    if (!appPath.endsWith('.app')) {
      throw new Error('invalid_path: must be a .app bundle');
    }
    const knownApps = await listInstalledApps();
    if (!knownApps.some((a) => a.path === appPath)) {
      throw new Error('unknown_app');
    }
    return extractIconPngBase64(appPath);
  }

  if (method === 'execute_command') {
    const command = params?.command || {};
    if (command?.action?.type === 'open_app') {
      return executeOpenApp(command);
    }
    if (command?.action?.type === 'minimize_app') {
      return executeMinimizeApp(command);
    }
    throw new Error('unsupported_command_type');
  }

  throw new Error(`unknown_method:${method}`);
}

function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect() {
  clearTimers();
  reconnectAttempt += 1;
  const backoff = Math.min(15000, 500 * (2 ** reconnectAttempt));
  reconnectTimer = setTimeout(connect, backoff);
}

function startPing() {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }, 20000);
}

function connect() {
  clearTimers();

  const target = new URL(BROKER_WS_URL);
  target.searchParams.set('deviceId', DEVICE_ID);

  ws = new WebSocket(target.toString());

  ws.on('open', () => {
    reconnectAttempt = 0;
    console.log(`[AGENT] connected -> ${target.origin}`);
    ws.send(JSON.stringify({
      type: 'agent_hello',
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      token: AGENT_TOKEN
    }));
    startPing();
  });

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type !== 'rpc') return;

    const id = String(data.id || '');
    const method = String(data.method || '');

    if (!id || !method) {
      return;
    }

    try {
      const result = await handleRpc(method, data.params || {});
      ws.send(JSON.stringify({
        type: 'rpc_result',
        id,
        ok: true,
        result
      }));
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'rpc_result',
        id,
        ok: false,
        error: err.message
      }));
    }
  });

  ws.on('close', () => {
    console.log('[AGENT] disconnected');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.warn(`[AGENT] socket error: ${err.message}`);
    try {
      ws.close();
    } catch {
      // ignore
    }
  });
}

process.on('SIGINT', () => {
  clearTimers();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'shutdown');
  }
  process.exit(0);
});

console.log('========================================');
console.log('Left Controller Mac Agent Started');
console.log(`Broker WS: ${BROKER_WS_URL}`);
console.log(`Device ID: ${DEVICE_ID}`);
console.log(`Device Name: ${DEVICE_NAME}`);
console.log(`Agent token: ${AGENT_TOKEN ? 'set' : 'not set'}`);
console.log('========================================');

connect();
