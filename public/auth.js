'use strict';

const UNLOCK_KEY = 'left_controller_unlocked';
const TOKEN_STORAGE_KEY = 'left_controller_token';
const TOKEN_EXPIRES_KEY = 'left_controller_token_expires';

function resolveWsUrl() {
  if (window.location.protocol === 'file:') {
    return 'ws://localhost:8080';
  }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}`;
}

const wsUrl = resolveWsUrl();

const wsUrlEl = document.getElementById('ws-url');
const wsUrlMiniEl = document.getElementById('ws-url-mini');
const wsStatusEl = document.getElementById('ws-status');
const wsStatusMiniEl = document.getElementById('ws-status-mini');
const lastEventEl = document.getElementById('last-event');
const authScreenStatusEl = document.getElementById('auth-screen-status');
const pairingHintEl = document.getElementById('pairing-hint');
const pinInput = document.getElementById('pin-input');
const authBtn = document.getElementById('auth-btn');
const clearCacheBtn = document.getElementById('clear-cache');

if (wsUrlEl) wsUrlEl.textContent = wsUrl;
if (wsUrlMiniEl) wsUrlMiniEl.textContent = wsUrl;

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let authPending = false;
let authRetryTimer = null;
let pinPolicy = { minDigits: 6, maxDigits: 8 };

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

function setAuthScreenStatus(text, okState) {
  if (!authScreenStatusEl) return;
  authScreenStatusEl.textContent = text;
  authScreenStatusEl.classList.remove('status-ok', 'status-ng');
  if (okState === true) authScreenStatusEl.classList.add('status-ok');
  if (okState === false) authScreenStatusEl.classList.add('status-ng');
}

function sendAuth() {
  const pin = pinInput.value.trim();
  if (!pin) return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  ws.send(JSON.stringify({ type: 'auth', pin }));
  return true;
}

function sendAuthToken() {
  const token = getStoredToken();
  if (!token) return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'auth_token', token }));
  return true;
}

function stopAuthRetryLoop() {
  authPending = false;
  if (authRetryTimer) {
    clearInterval(authRetryTimer);
    authRetryTimer = null;
  }
}

function beginAuthRetryLoop() {
  if (authRetryTimer) return;
  authRetryTimer = setInterval(() => {
    if (!authPending) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendAuth();
  }, 1200);
}

function requestAuthFlow() {
  const pin = pinInput.value.trim();
  const minDigits = Number(pinPolicy.minDigits || 6);
  const maxDigits = Number(pinPolicy.maxDigits || 8);
  const pinRegex = new RegExp(`^\\d{${minDigits},${maxDigits}}$`);
  if (!pinRegex.test(pin)) {
    setAuthScreenStatus(`PINは${minDigits}〜${maxDigits}桁の数字で入力してください`, false);
    return;
  }
  authPending = true;
  beginAuthRetryLoop();
  sendAuth();
  setAuthScreenStatus('認証処理中...', null);
  setLastEvent('auth requested');
}

async function loadPairingInfo() {
  if (!pairingHintEl) return;
  try {
    const res = await fetch('/api/pairing', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    if (data.requirePin) {
      const policy = data.pinPolicy || {};
      const minDigits = policy.minDigits || 6;
      const maxDigits = policy.maxDigits || 8;
      pinPolicy = { minDigits, maxDigits };
      pairingHintEl.textContent = `Mac「${data.deviceName || '-'}」の管理画面PINを入力（推奨 ${minDigits}〜${maxDigits}桁）。`;
    } else {
      pairingHintEl.textContent = 'このサーバーはPIN認証が無効です。';
    }
  } catch {
    // ignore
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

    if (sendAuthToken()) {
      setAuthScreenStatus('セッション認証中...', null);
      return;
    }

    if (authPending && pinInput.value.trim()) {
      sendAuth();
      setAuthScreenStatus('認証再送中...', null);
    }
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
      if (sendAuthToken()) {
        setAuthScreenStatus('セッション認証中...', null);
        return;
      }
      if (authPending) {
        sendAuth();
      }
      setAuthScreenStatus('PINを入力して認証', false);
      return;
    }

    if (data.type === 'auth_result') {
      if (data.ok) {
        stopAuthRetryLoop();
        if (data.token) {
          sessionStorage.setItem(TOKEN_STORAGE_KEY, data.token);
        }
        if (data.expiresAt) {
          sessionStorage.setItem(TOKEN_EXPIRES_KEY, String(data.expiresAt));
        }
        setAuthScreenStatus('認証済み', true);
        sessionStorage.setItem(UNLOCK_KEY, '1');
        setLastEvent('auth success -> controller');
        window.location.replace('/controller.html');
      } else {
        stopAuthRetryLoop();
        sessionStorage.removeItem(UNLOCK_KEY);
        if (data.reason === 'locked' && data.retryAfterSeconds) {
          setAuthScreenStatus(`ロック中: ${data.retryAfterSeconds}秒後に再試行`, false);
        } else {
          setAuthScreenStatus('認証エラー', false);
        }
        setLastEvent('auth failed');
      }
      return;
    }

    if (data.type === 'error') {
      setLastEvent(`Server error: ${data.message}`);
    }
  });

  ws.addEventListener('error', () => {
    setStatus('エラー', false);
    setLastEvent('WebSocket error');
  });

  ws.addEventListener('close', () => {
    setStatus('切断', false);
    setLastEvent('WebSocket closed');

    reconnectAttempts += 1;
    const backoff = Math.min(5000, 400 * (2 ** reconnectAttempts));
    reconnectTimer = setTimeout(connectWebSocket, backoff);
  });
}

if (authBtn) {
  authBtn.addEventListener('click', () => {
    requestAuthFlow();
  });
}

if (pinInput) {
  pinInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    requestAuthFlow();
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

setAuthScreenStatus('未認証', false);
loadPairingInfo();
connectWebSocket();
