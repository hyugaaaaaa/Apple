'use strict';

const wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
const wsUrl = wsProtocol + window.location.hostname + ':8080';

const PIN_STORAGE_KEY = 'left_controller_pin';
const MIN_SEND_INTERVAL_MS = 180;
const HOLD_MS = 450;

const DEFAULT_COMMANDS = [
  { id: 'open_safari', label: 'Safariを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_finder', label: 'Finderを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_terminal', label: 'Terminalを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_codex', label: 'Codexを開く', ui: { requireHold: false, dangerous: false } }
];

const ICON_MAP = {
  open_safari: { emoji: '🧭', className: 'icon-safari' },
  open_finder: { emoji: '🙂', className: 'icon-finder' },
  open_terminal: { emoji: '⌘', className: 'icon-terminal' },
  open_codex: { emoji: '⌬', className: 'icon-codex' }
};

const wsUrlEl = document.getElementById('ws-url');
const wsStatusEl = document.getElementById('ws-status');
const authStatusEl = document.getElementById('auth-status');
const commandCountEl = document.getElementById('command-count');
const lastEventEl = document.getElementById('last-event');
const clearCacheBtn = document.getElementById('clear-cache');
const pinInput = document.getElementById('pin-input');
const authBtn = document.getElementById('auth-btn');
const lockBtn = document.getElementById('lock-btn');
const gridEl = document.getElementById('command-grid');
const railDotsEl = document.getElementById('rail-dots');

const appsView = document.getElementById('apps-view');
const aboutView = document.getElementById('about-view');
const tabApps = document.getElementById('tab-apps');
const tabAbout = document.getElementById('tab-about');
const tabClock = document.getElementById('tab-clock');

wsUrlEl.textContent = wsUrl;

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isAuthed = false;
let lastSentAt = 0;

const holdTimers = new Map();

const savedPin = localStorage.getItem(PIN_STORAGE_KEY) || '';
if (savedPin) {
  pinInput.value = savedPin;
}

setAuth(false, '未認証');

function setStatus(text, okState) {
  wsStatusEl.textContent = text;
  wsStatusEl.classList.remove('status-ok', 'status-ng');
  if (okState === true) wsStatusEl.classList.add('status-ok');
  if (okState === false) wsStatusEl.classList.add('status-ng');
}

function setAuth(ok, message) {
  isAuthed = ok;
  authStatusEl.textContent = message;
  authStatusEl.classList.remove('status-ok', 'status-ng');
  authStatusEl.classList.add(ok ? 'status-ok' : 'status-ng');

  const buttons = gridEl.querySelectorAll('.pad-btn');
  buttons.forEach((btn) => {
    btn.disabled = !ok;
  });
}

function setLastEvent(text) {
  lastEventEl.textContent = `${new Date().toLocaleTimeString()} - ${text}`;
}

function setActiveView(view) {
  const isApps = view === 'apps';

  appsView.classList.toggle('active', isApps);
  aboutView.classList.toggle('active', !isApps);

  tabApps.classList.toggle('active', isApps);
  tabAbout.classList.toggle('active', !isApps);
}

function renderRailDots(commandCount) {
  railDotsEl.innerHTML = '';
  const dotCount = Math.max(6, Math.min(12, commandCount));

  for (let i = 0; i < dotCount; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'rail-dot';
    railDotsEl.appendChild(dot);
  }
}

function autoAuthenticate() {
  const pin = pinInput.value.trim();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'auth',
    pin
  }));
}

function connectWebSocket() {
  clearTimeout(reconnectTimer);
  setStatus('接続中...', null);

  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    setStatus('接続中(OK)', true);
    setLastEvent('WebSocket connected');
    autoAuthenticate();
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'auth_required') {
        setAuth(false, 'PIN必要');
        setLastEvent(data.message || 'PIN authentication required');
        return;
      }

      if (data.type === 'auth_result') {
        if (data.ok) {
          setAuth(true, '認証済み');
          localStorage.setItem(PIN_STORAGE_KEY, pinInput.value.trim());
        } else {
          setAuth(false, 'PINエラー');
        }
        setLastEvent(data.message || 'Auth updated');
        return;
      }

      if (data.type === 'command_result') {
        const label = data.ok ? '成功' : '失敗';
        setLastEvent(`${data.command || '-'}: ${label} ${data.message || ''}`);
        return;
      }

      if (data.type === 'error') {
        setLastEvent(`Server error: ${data.message}`);
        return;
      }

      setLastEvent(`Message: ${event.data}`);
    } catch {
      setLastEvent(`Raw: ${event.data}`);
    }
  });

  ws.addEventListener('error', () => {
    setStatus('エラー', false);
    setLastEvent('WebSocket error');
  });

  ws.addEventListener('close', () => {
    setStatus('切断', false);
    setAuth(false, '未接続');
    setLastEvent('WebSocket closed');

    reconnectAttempts += 1;
    const backoff = Math.min(5000, 400 * (2 ** reconnectAttempts));
    reconnectTimer = setTimeout(connectWebSocket, backoff);
  });
}

function canSendNow() {
  const now = Date.now();
  if (now - lastSentAt < MIN_SEND_INTERVAL_MS) {
    return false;
  }
  lastSentAt = now;
  return true;
}

function sendCommand(commandId, dangerous) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setLastEvent(`送信失敗: WS未接続 (${commandId})`);
    return;
  }

  if (!isAuthed) {
    setLastEvent(`送信失敗: 未認証 (${commandId})`);
    return;
  }

  if (!canSendNow()) {
    setLastEvent(`連打制限: ${commandId}`);
    return;
  }

  if (dangerous) {
    const ok = window.confirm(`\"${commandId}\" を実行しますか？`);
    if (!ok) {
      setLastEvent(`キャンセル: ${commandId}`);
      return;
    }
  }

  ws.send(JSON.stringify({
    type: 'command',
    command: commandId,
    requestId: `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }));
}

function clearHold(btn) {
  const timer = holdTimers.get(btn);
  if (timer) {
    clearTimeout(timer);
    holdTimers.delete(btn);
  }
  btn.classList.remove('holding');
}

function startHold(btn, commandId, dangerous) {
  clearHold(btn);
  btn.classList.add('holding');

  const timer = setTimeout(() => {
    sendCommand(commandId, dangerous);
    clearHold(btn);
  }, HOLD_MS);

  holdTimers.set(btn, timer);
}

function bindButton(btn) {
  const commandId = btn.dataset.command;
  const requireHold = btn.dataset.requireHold === 'true';
  const dangerous = btn.dataset.dangerous === 'true';
  const hasPointer = 'PointerEvent' in window;

  const onPressStart = (event) => {
    event.preventDefault();
    if (requireHold) {
      startHold(btn, commandId, dangerous);
      return;
    }
    sendCommand(commandId, dangerous);
  };

  const onPressEnd = (event) => {
    if (requireHold) {
      event.preventDefault();
      clearHold(btn);
    }
  };

  if (hasPointer) {
    btn.addEventListener('pointerdown', onPressStart);
    btn.addEventListener('pointerup', onPressEnd);
    btn.addEventListener('pointercancel', onPressEnd);
    btn.addEventListener('pointerleave', onPressEnd);
  } else {
    btn.addEventListener('touchstart', onPressStart, { passive: false });
    btn.addEventListener('touchend', onPressEnd, { passive: false });
    btn.addEventListener('touchcancel', onPressEnd, { passive: false });
  }

  btn.addEventListener('click', (event) => {
    event.preventDefault();
  });
}

function buildTile(command) {
  const icon = ICON_MAP[command.id] || { emoji: '⬢', className: 'icon-codex' };
  const iconUrl = command.ui?.iconUrl || '';
  const iconInner = iconUrl
    ? `<img class="real-icon" src="${iconUrl}" alt="" />`
    : icon.emoji;
  const hasRealClass = iconUrl ? 'has-real' : '';

  return `
    <span class="tile">
      <span class="app-icon ${icon.className} ${hasRealClass}" aria-hidden="true">${iconInner}</span>
    </span>
  `;
}

function renderCommandButtons(commands) {
  gridEl.innerHTML = '';

  commands.forEach((cmd) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pad-btn';
    button.innerHTML = buildTile(cmd);
    button.dataset.command = cmd.id;
    button.dataset.requireHold = cmd.ui?.requireHold ? 'true' : 'false';
    button.dataset.dangerous = cmd.ui?.dangerous ? 'true' : 'false';
    button.setAttribute('aria-label', cmd.label);
    button.title = cmd.label;

    if (cmd.ui?.requireHold) {
      button.classList.add('hold-required');
    }
    if (cmd.ui?.dangerous) {
      button.classList.add('danger');
    }

    gridEl.appendChild(button);
  });

  commandCountEl.textContent = String(commands.length);
  renderRailDots(commands.length);

  const buttons = gridEl.querySelectorAll('.pad-btn');
  buttons.forEach(bindButton);

  setAuth(isAuthed, authStatusEl.textContent || '未認証');
}

async function loadCommandsFromServer() {
  try {
    const res = await fetch('/api/commands', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.ok || !Array.isArray(data.commands)) {
      throw new Error('Invalid command response');
    }

    renderCommandButtons(data.commands);
    setLastEvent(`commands loaded (${data.commands.length})`);
  } catch (err) {
    renderCommandButtons(DEFAULT_COMMANDS);
    setLastEvent(`commands fallback: ${err.message}`);
  }
}

clearCacheBtn.addEventListener('click', async () => {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    setLastEvent('キャッシュとService Workerをクリアしました。再読み込みします。');
    setTimeout(() => window.location.reload(), 500);
  } catch (err) {
    setLastEvent(`クリア失敗: ${err.message}`);
  }
});

authBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setLastEvent('認証失敗: WS未接続');
    return;
  }
  autoAuthenticate();
  setLastEvent('認証を送信しました');
});

lockBtn.addEventListener('click', () => {
  setAuth(false, 'ロック中');
  setLastEvent('ロックしました');
});

tabApps.addEventListener('click', () => {
  setActiveView('apps');
});

tabAbout.addEventListener('click', () => {
  setActiveView('about');
});

tabClock.addEventListener('click', () => {
  setLastEvent(`Clock tap: ${new Date().toLocaleTimeString()}`);
  setActiveView('about');
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('/sw.js');
      setLastEvent('Service Worker registered');
    } catch (err) {
      setLastEvent(`SW登録失敗: ${err.message}`);
    }
  });
}

setActiveView('apps');
loadCommandsFromServer();
connectWebSocket();
