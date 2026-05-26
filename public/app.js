'use strict';

function resolveWsUrl() {
  if (window.location.protocol === 'file:') {
    return 'ws://localhost:8080';
  }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}`;
}
const wsUrl = resolveWsUrl();

const PIN_STORAGE_KEY = 'left_controller_pin';
const MIN_SEND_INTERVAL_MS = 180;
const HOLD_MS = 450;

const DEFAULT_COMMANDS = [
  { id: 'open_safari', label: 'Safariを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_finder', label: 'Finderを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_terminal', label: 'Terminalを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_codex', label: 'Codexを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_music', label: 'Musicを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_mail', label: 'Mailを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_notes', label: 'メモを開く', ui: { requireHold: false, dangerous: false } },
  { id: 'open_settings', label: '設定を開く', ui: { requireHold: false, dangerous: false } }
];

const ICON_MAP = {
  open_safari: { emoji: '🧭', className: 'icon-safari' },
  open_finder: { emoji: '🙂', className: 'icon-finder' },
  open_terminal: { emoji: '⌘', className: 'icon-terminal' },
  open_codex: { emoji: '⌬', className: 'icon-codex' },
  open_music: { emoji: '🎵', className: 'icon-music' },
  open_mail: { emoji: '✉️', className: 'icon-mail' },
  open_notes: { emoji: '📝', className: 'icon-notes' },
  open_settings: { emoji: '⚙️', className: 'icon-settings' }
};

const wsUrlEl = document.getElementById('ws-url');
const wsUrlMiniEl = document.getElementById('ws-url-mini');
const wsStatusEl = document.getElementById('ws-status');
const wsStatusMiniEl = document.getElementById('ws-status-mini');
const authStatusEl = document.getElementById('auth-status');
const authScreenStatusEl = document.getElementById('auth-screen-status');
const commandCountEl = document.getElementById('command-count');
const lastEventEl = document.getElementById('last-event');
const clearCacheBtn = document.getElementById('clear-cache');
const pinInput = document.getElementById('pin-input');
const authBtn = document.getElementById('auth-btn');
const lockBtn = document.getElementById('lock-btn');
const gridEl = document.getElementById('command-grid');
const authScreen = document.getElementById('auth-screen');
const controllerScreen = document.getElementById('controller-screen');

if (wsUrlEl) wsUrlEl.textContent = wsUrl;
if (wsUrlMiniEl) wsUrlMiniEl.textContent = wsUrl;

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isAuthed = false;
let pinUnlocked = false;
let isAuthPending = false;
let authRetryTimer = null;
let sessionToken = '';
let lastSentAt = 0;

const holdTimers = new Map();
const ICON_CACHE_BUST = Date.now();

const savedPin = localStorage.getItem(PIN_STORAGE_KEY) || '';
if (savedPin) {
  pinInput.value = savedPin;
}

setAuth(false, '未認証');

function setStatus(text, okState) {
  if (wsStatusEl) {
    wsStatusEl.textContent = text;
    wsStatusEl.classList.remove('status-ok', 'status-ng');
    if (okState === true) wsStatusEl.classList.add('status-ok');
    if (okState === false) wsStatusEl.classList.add('status-ng');
  }
  if (wsStatusMiniEl) {
    wsStatusMiniEl.textContent = text;
    wsStatusMiniEl.classList.remove('status-ok', 'status-ng');
    if (okState === true) wsStatusMiniEl.classList.add('status-ok');
    if (okState === false) wsStatusMiniEl.classList.add('status-ng');
  }
}

function setAuth(ok, message) {
  isAuthed = ok;
  if (ok) {
    pinUnlocked = true;
  }
  if (authStatusEl) {
    authStatusEl.textContent = message;
    authStatusEl.classList.remove('status-ok', 'status-ng');
    authStatusEl.classList.add(ok ? 'status-ok' : 'status-ng');
  }
  if (authScreenStatusEl) {
    authScreenStatusEl.textContent = message;
    authScreenStatusEl.classList.remove('status-ok', 'status-ng');
    authScreenStatusEl.classList.add(ok ? 'status-ok' : 'status-ng');
  }
  syncScreenVisibility();

  syncButtonsEnabled();
}

function stopAuthRetryLoop() {
  isAuthPending = false;
  if (authRetryTimer) {
    clearInterval(authRetryTimer);
    authRetryTimer = null;
  }
}

function sendAuthRequest() {
  const pin = pinInput.value.trim();
  if (!pin) return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  ws.send(JSON.stringify({
    type: 'auth',
    pin
  }));
  return true;
}

function beginAuthRetryLoop() {
  if (authRetryTimer) return;
  authRetryTimer = setInterval(() => {
    if (!isAuthPending) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendAuthRequest();
  }, 1200);
}

function syncScreenVisibility() {
  if (!authScreen || !controllerScreen) return;
  authScreen.hidden = pinUnlocked;
  controllerScreen.hidden = !pinUnlocked;
}

function syncButtonsEnabled() {
  const buttons = gridEl.querySelectorAll('.pad-btn');
  buttons.forEach((btn) => {
    btn.disabled = !(pinUnlocked && isAuthed && ws && ws.readyState === WebSocket.OPEN);
  });
}

function setLastEvent(text) {
  if (lastEventEl) lastEventEl.textContent = `${new Date().toLocaleTimeString()} - ${text}`;
}

function autoAuthenticate() {
  const pin = pinInput.value.trim();
  if (!pin) return;

  isAuthPending = true;
  beginAuthRetryLoop();
  sendAuthRequest();
}

function ensureConnectedNow() {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connectWebSocket();
  }
}

function connectWebSocket() {
  clearTimeout(reconnectTimer);
  setStatus('接続中...', null);

  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    setStatus('接続中(OK)', true);
    setLastEvent('WebSocket connected');
    if ((isAuthPending || pinUnlocked) && pinInput.value.trim()) {
      autoAuthenticate();
      setLastEvent('再接続: 自動認証中');
    } else {
      setLastEvent('PINを入力して認証してください');
    }
    syncButtonsEnabled();
  });

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'auth_required') {
        setAuth(false, 'PIN必要');
        if ((isAuthPending || pinUnlocked) && pinInput.value.trim()) {
          autoAuthenticate();
          setLastEvent('PIN required -> 自動再認証');
          return;
        }
        setLastEvent(data.message || 'PIN authentication required');
        return;
      }

      if (data.type === 'auth_result') {
        stopAuthRetryLoop();
        if (data.ok) {
          sessionToken = data.token || '';
          setAuth(true, '認証済み');
          localStorage.setItem(PIN_STORAGE_KEY, pinInput.value.trim());
          loadCommandsFromServer();
        } else {
          pinUnlocked = false;
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
    syncButtonsEnabled();
  });

  ws.addEventListener('close', () => {
    setStatus('切断', false);
    isAuthed = false;
    if (authStatusEl) {
      authStatusEl.textContent = '未接続';
      authStatusEl.classList.remove('status-ok');
      authStatusEl.classList.add('status-ng');
    }
    if (authScreenStatusEl) {
      authScreenStatusEl.textContent = pinUnlocked ? '再接続中...' : '未接続';
      authScreenStatusEl.classList.remove('status-ok');
      authScreenStatusEl.classList.add('status-ng');
    }
    syncButtonsEnabled();
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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildFallbackLabel(command) {
  const label = String(command?.label || '')
    .replace(/を開く$/, '')
    .trim();
  const first = label ? Array.from(label)[0] : '';
  return escapeHtml(first || '•');
}

function withIconCacheBust(iconUrl) {
  const raw = String(iconUrl || '').trim();
  if (!raw) return '';
  const sep = raw.includes('?') ? '&' : '?';
  return `${raw}${sep}cb=${ICON_CACHE_BUST}`;
}

function buildTile(command) {
  const icon = ICON_MAP[command.id] || { emoji: '⬢', className: 'icon-codex' };
  const iconUrl = withIconCacheBust(command.ui?.iconUrl || '');
  const fallbackLabel = buildFallbackLabel(command);
  const iconInner = iconUrl
    ? `<span class="fallback-mark">${fallbackLabel}</span><img class="real-icon" src="${iconUrl}" alt="" loading="eager" decoding="async" onerror="this.style.display='none'; this.parentElement.classList.remove('has-real');" />`
    : `<span class="fallback-mark">${escapeHtml(icon.emoji)}</span>`;
  const hasRealClass = iconUrl ? 'has-real' : '';

  return `
    <span class="tile">
      <span class="app-icon ${icon.className} ${hasRealClass}" aria-hidden="true">${iconInner}</span>
    </span>
  `;
}

function renderCommandButtons(commands) {
  if (gridEl) {
    gridEl.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))';
    gridEl.style.gridTemplateRows = 'repeat(4, auto)';
    gridEl.style.justifyItems = 'center';
    gridEl.style.alignItems = 'start';
    gridEl.style.gap = '18px 12px';
  }

  gridEl.innerHTML = '';

  commands.forEach((cmd) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pad-btn';
    button.style.all = 'unset';
    button.style.display = 'grid';
    button.style.placeItems = 'center';
    button.style.background = 'transparent';
    button.style.border = '0';
    button.style.boxShadow = 'none';
    button.style.margin = '0';
    button.style.padding = '0';
    button.style.cursor = 'pointer';
    button.style.touchAction = 'manipulation';
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

  if (commandCountEl) commandCountEl.textContent = String(commands.length);

  const buttons = gridEl.querySelectorAll('.pad-btn');
  buttons.forEach(bindButton);

  setAuth(isAuthed, authStatusEl?.textContent || '未認証');
  syncButtonsEnabled();
}

async function loadCommandsFromServer() {
  try {
    const headers = sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {};
    const res = await fetch('/api/commands', { cache: 'no-store', headers });
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

if (clearCacheBtn) {
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
}

if (authBtn) {
  authBtn.addEventListener('click', () => {
    if (!pinInput.value.trim()) {
      setLastEvent('PINを入力してください');
      return;
    }

    // UX優先: 先にコントローラー画面へ遷移し、認証完了まではボタン無効のまま待機する。
    pinUnlocked = true;
    syncScreenVisibility();
    syncButtonsEnabled();

    ensureConnectedNow();
    autoAuthenticate();
    setLastEvent('認証処理中…（接続が不安定でも自動再試行します）');
  });
}

if (lockBtn) {
  lockBtn.addEventListener('click', () => {
    stopAuthRetryLoop();
    pinUnlocked = false;
    setAuth(false, 'ロック中');
    setLastEvent('ロックしました');
  });
}

if (pinInput) {
  pinInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (authBtn) authBtn.click();
  });
}

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

loadCommandsFromServer();
connectWebSocket();
syncScreenVisibility();
