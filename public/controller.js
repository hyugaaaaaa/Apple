'use strict';

const UNLOCK_KEY = 'left_controller_unlocked';
const TOKEN_STORAGE_KEY = 'left_controller_token';
const TOKEN_EXPIRES_KEY = 'left_controller_token_expires';
const MIN_SEND_INTERVAL_MS = 180;
const HOLD_MS = 450;
const ITEMS_PER_PAGE = 8;
const MAX_PAGES = 3;
const MAX_COMMANDS = ITEMS_PER_PAGE * MAX_PAGES;

function resolveWsUrl() {
  if (window.location.protocol === 'file:') {
    return 'ws://localhost:8080';
  }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}`;
}

const wsUrl = resolveWsUrl();

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
const commandCountEl = document.getElementById('command-count');
const lastEventEl = document.getElementById('last-event');
const clearCacheBtn = document.getElementById('clear-cache');
const lockBtn = document.getElementById('lock-btn');
const gridEl = document.getElementById('command-grid');
const pagePrevBtn = document.getElementById('page-prev');
const pageNextBtn = document.getElementById('page-next');
const pageDotsEl = document.getElementById('page-dots');
const debugMiniEl = document.querySelector('.debug-mini');
const debugDrawerEl = document.querySelector('.debug-drawer');

if (wsUrlEl) wsUrlEl.textContent = wsUrl;
if (wsUrlMiniEl) wsUrlMiniEl.textContent = wsUrl;

if (sessionStorage.getItem(UNLOCK_KEY) !== '1') {
  window.location.replace('/auth.html');
}

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isAuthed = false;
let authPending = false;
let authRetryTimer = null;
let lastSentAt = 0;
let currentPage = 0;
let allCommands = [];
let pagedCommands = [[], [], []];
let commandsLoading = false;
let commandsReloadPending = false;

const holdTimers = new Map();

function getStoredToken() {
  const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || '';
  const expiresAt = Number(sessionStorage.getItem(TOKEN_EXPIRES_KEY) || '0');
  if (!token) return '';
  if (expiresAt && Date.now() >= expiresAt) {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(TOKEN_EXPIRES_KEY);
    return '';
  }
  return token;
}

function setDebugVisibility(show) {
  const display = show ? '' : 'none';
  if (debugMiniEl) debugMiniEl.style.display = display;
  if (debugDrawerEl) debugDrawerEl.style.display = display;
}

async function applyRuntimeUiConfig() {
  try {
    const res = await fetch('/api/runtime', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || data.ok !== true) return;
    setDebugVisibility(data.debugUi === true);
  } catch {
    // fallback: keep current visibility
  }
}

function setLastEvent(text) {
  if (lastEventEl) lastEventEl.textContent = `${new Date().toLocaleTimeString()} - ${text}`;
}

function setStatus(text, okState) {
  for (const el of [wsStatusEl, wsStatusMiniEl]) {
    if (!el) continue;
    el.textContent = text;
    el.classList.remove('status-ok', 'status-ng');
    if (okState === true) el.classList.add('status-ok');
    if (okState === false) el.classList.add('status-ng');
  }
}

function setAuth(ok, message) {
  isAuthed = ok;
  if (authStatusEl) {
    authStatusEl.textContent = message;
    authStatusEl.classList.remove('status-ok', 'status-ng');
    authStatusEl.classList.add(ok ? 'status-ok' : 'status-ng');
  }
  syncButtonsEnabled();
}

function syncButtonsEnabled() {
  const canUse = !!(isAuthed && ws && ws.readyState === WebSocket.OPEN);
  gridEl.querySelectorAll('.pad-btn').forEach((btn) => {
    btn.disabled = !canUse;
  });
}

function stopAuthRetryLoop() {
  authPending = false;
  if (authRetryTimer) {
    clearInterval(authRetryTimer);
    authRetryTimer = null;
  }
}

function sendAuth() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const token = getStoredToken();
  if (!token) return false;
  ws.send(JSON.stringify({ type: 'auth_token', token }));
  return true;
}

function beginAuthRetryLoop() {
  if (authRetryTimer) return;
  authRetryTimer = setInterval(() => {
    if (!authPending) return;
    sendAuth();
  }, 1200);
}

function requestAuth() {
  if (!getStoredToken()) {
    sessionStorage.removeItem(UNLOCK_KEY);
    window.location.replace('/auth.html');
    return;
  }
  authPending = true;
  beginAuthRetryLoop();
  sendAuth();
}

function connectWebSocket() {
  clearTimeout(reconnectTimer);
  setStatus('接続中...', null);

  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    setStatus('接続中(OK)', true);
    setLastEvent('WebSocket connected');
    requestAuth();
    loadCommandsFromServer();
    syncButtonsEnabled();
  });

  ws.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      setLastEvent(`Raw: ${event.data}`);
      return;
    }

    if (data.type === 'auth_required') {
      setAuth(false, 'PIN必要');
      requestAuth();
      return;
    }

    if (data.type === 'auth_result') {
      stopAuthRetryLoop();
      if (data.ok) {
        if (data.token) {
          sessionStorage.setItem(TOKEN_STORAGE_KEY, data.token);
        }
        if (data.expiresAt) {
          sessionStorage.setItem(TOKEN_EXPIRES_KEY, String(data.expiresAt));
        }
        setAuth(true, '認証済み');
      } else {
        setAuth(false, data.reason === 'token_expired' ? 'セッション期限切れ' : '認証エラー');
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        sessionStorage.removeItem(TOKEN_EXPIRES_KEY);
        sessionStorage.removeItem(UNLOCK_KEY);
        setLastEvent('認証失敗。認証画面へ戻ります。');
        setTimeout(() => window.location.replace('/auth.html'), 500);
      }
      return;
    }

    if (data.type === 'command_result') {
      const label = data.ok ? '成功' : '失敗';
      setLastEvent(`${data.command || '-'}: ${label} ${data.message || ''}`);
      return;
    }

    if (data.type === 'commands_updated') {
      setLastEvent(`commands updated (${data.count || '-'}件)`);
      loadCommandsFromServer();
      return;
    }

    if (data.type === 'error') {
      setLastEvent(`Server error: ${data.message}`);
    }
  });

  ws.addEventListener('error', () => {
    setStatus('エラー', false);
    syncButtonsEnabled();
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
  if (now - lastSentAt < MIN_SEND_INTERVAL_MS) return false;
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
  if (dangerous && !window.confirm(`\"${commandId}\" を実行しますか？`)) {
    setLastEvent(`キャンセル: ${commandId}`);
    return;
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
    if (!requireHold) return;
    event.preventDefault();
    clearHold(btn);
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

  btn.addEventListener('click', (event) => event.preventDefault());
}

function buildTile(command) {
  const icon = ICON_MAP[command.id] || { emoji: '⬢', className: 'icon-codex' };
  const iconUrl = command.ui?.iconUrl || '';
  const iconInner = iconUrl
    ? `<img class=\"real-icon\" src=\"${iconUrl}\" alt=\"\" />`
    : icon.emoji;
  const hasRealClass = iconUrl ? 'has-real' : '';

  return `
    <span class="tile">
      <span class="app-icon ${icon.className} ${hasRealClass}" aria-hidden="true">${iconInner}</span>
    </span>
  `;
}

function buildPagedCommands(commands) {
  const list = Array.isArray(commands) ? commands : [];
  const slotArray = Array(MAX_COMMANDS).fill(null);
  const fallbackQueue = [];

  list.forEach((cmd) => {
    const slot = Number(cmd?.ui?.slot);
    if (Number.isInteger(slot) && slot >= 0 && slot < MAX_COMMANDS && !slotArray[slot]) {
      slotArray[slot] = cmd;
      return;
    }
    fallbackQueue.push(cmd);
  });

  for (let i = 0; i < MAX_COMMANDS && fallbackQueue.length > 0; i += 1) {
    if (slotArray[i]) continue;
    slotArray[i] = fallbackQueue.shift();
  }

  const pages = [];
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const start = i * ITEMS_PER_PAGE;
    pages.push(slotArray.slice(start, start + ITEMS_PER_PAGE));
  }

  return { limited: slotArray.filter(Boolean), pages };
}

function renderPageNav() {
  if (!pageDotsEl) return;
  pageDotsEl.innerHTML = '';

  for (let i = 0; i < MAX_PAGES; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'page-dot';
    if (i === currentPage) dot.classList.add('active');
    if (pagedCommands[i].length === 0) dot.classList.add('empty');
    dot.setAttribute('aria-label', `${i + 1}ページ目`);
    dot.addEventListener('click', () => {
      setPage(i);
    });
    pageDotsEl.appendChild(dot);
  }

  if (pagePrevBtn) pagePrevBtn.disabled = currentPage <= 0;
  if (pageNextBtn) pageNextBtn.disabled = currentPage >= MAX_PAGES - 1;
}

function renderCommandButtons(commands) {
  gridEl.innerHTML = '';
  const pageSlots = Array.isArray(commands) ? commands.slice(0, ITEMS_PER_PAGE) : [];
  for (let i = 0; i < ITEMS_PER_PAGE; i += 1) {
    const cmd = pageSlots[i];
    if (!cmd) {
      const slot = document.createElement('div');
      slot.className = 'pad-placeholder';
      slot.setAttribute('aria-hidden', 'true');
      gridEl.appendChild(slot);
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pad-btn';
    button.innerHTML = buildTile(cmd);
    button.dataset.command = cmd.id;
    button.dataset.requireHold = cmd.ui?.requireHold ? 'true' : 'false';
    button.dataset.dangerous = cmd.ui?.dangerous ? 'true' : 'false';
    button.setAttribute('aria-label', cmd.label);
    button.title = cmd.label;
    gridEl.appendChild(button);
  }

  gridEl.querySelectorAll('.pad-btn').forEach(bindButton);
  syncButtonsEnabled();
}

function setPage(nextPage) {
  const clamped = Math.max(0, Math.min(MAX_PAGES - 1, nextPage));
  currentPage = clamped;
  renderPageNav();
  renderCommandButtons(pagedCommands[currentPage]);
}

function setCommands(nextCommands) {
  const { limited, pages } = buildPagedCommands(nextCommands);
  allCommands = limited;
  pagedCommands = pages;

  if (commandCountEl) commandCountEl.textContent = String(allCommands.length);

  let maxPageWithData = 0;
  for (let i = MAX_PAGES - 1; i >= 0; i -= 1) {
    if (pages[i].length > 0) {
      maxPageWithData = i;
      break;
    }
  }
  if (currentPage > maxPageWithData) {
    currentPage = maxPageWithData;
  }
  setPage(currentPage);
}

async function loadCommandsFromServer() {
  if (commandsLoading) {
    commandsReloadPending = true;
    return;
  }
  commandsLoading = true;

  try {
    const res = await fetch('/api/commands', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.commands)) throw new Error('Invalid command response');

    setCommands(data.commands);
    const over = data.commands.length > MAX_COMMANDS ? ` / 上限${MAX_COMMANDS}件に調整` : '';
    setLastEvent(`commands loaded (${Math.min(data.commands.length, MAX_COMMANDS)}件${over})`);
  } catch (err) {
    setCommands(DEFAULT_COMMANDS);
    setLastEvent(`commands fallback: ${err.message}`);
  } finally {
    commandsLoading = false;
    if (commandsReloadPending) {
      commandsReloadPending = false;
      loadCommandsFromServer();
    }
  }
}

if (lockBtn) {
  lockBtn.addEventListener('click', () => {
    stopAuthRetryLoop();
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(TOKEN_EXPIRES_KEY);
    sessionStorage.removeItem(UNLOCK_KEY);
    setAuth(false, 'ロック中');
    setLastEvent('ロックしました');
    setTimeout(() => window.location.replace('/auth.html'), 250);
  });
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
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(TOKEN_EXPIRES_KEY);
      sessionStorage.removeItem(UNLOCK_KEY);
      setLastEvent('キャッシュとService Workerをクリアしました。再読み込みします。');
      setTimeout(() => window.location.reload(), 500);
    } catch (err) {
      setLastEvent(`クリア失敗: ${err.message}`);
    }
  });
}

if (pagePrevBtn) {
  pagePrevBtn.addEventListener('click', () => {
    setPage(currentPage - 1);
  });
}

if (pageNextBtn) {
  pageNextBtn.addEventListener('click', () => {
    setPage(currentPage + 1);
  });
}

if (gridEl) {
  let startX = 0;
  let startY = 0;

  gridEl.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });

  gridEl.addEventListener('touchend', (event) => {
    const touch = event.changedTouches && event.changedTouches[0];
    if (!touch) return;

    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;

    if (dx < 0) setPage(currentPage + 1);
    if (dx > 0) setPage(currentPage - 1);
  }, { passive: true });
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

window.addEventListener('pageshow', () => {
  loadCommandsFromServer();
});

window.addEventListener('focus', () => {
  loadCommandsFromServer();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    loadCommandsFromServer();
  }
});

setAuth(false, '未認証');
applyRuntimeUiConfig();
loadCommandsFromServer();
connectWebSocket();
