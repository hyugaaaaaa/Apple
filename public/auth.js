'use strict';

const UNLOCK_KEY = 'left_controller_unlocked';
const TOKEN_STORAGE_KEY = 'left_controller_token';
const TOKEN_EXPIRES_KEY = 'left_controller_token_expires';

const wsUrl = window.LeftController.resolveWsUrl();

const authScreenStatusEl = document.getElementById('auth-screen-status');
const pairingHintEl = document.getElementById('pairing-hint');
const pinInput = document.getElementById('pin-input');
const authBtn = document.getElementById('auth-btn');

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let authPending = false;
let authRetryTimer = null;
let pinPolicy = { minDigits: 6, maxDigits: 8 };

const deviceId = window.LeftController.getOrCreateDeviceId();
const deviceName = window.LeftController.buildDeviceName();

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
  void text;
}

function setStatus(text, okState) {
  void text;
  void okState;
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

  ws.send(JSON.stringify({ type: 'auth', pin, deviceId, deviceName }));
  return true;
}

function sendAuthToken() {
  const token = getStoredToken();
  if (!token) return false;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: 'auth_token', token, deviceId }));
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
    const qs = new URLSearchParams({
      deviceId,
      deviceName
    });
    const res = await fetch(`/api/pairing?${qs.toString()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    if (data.requirePin) {
      const policy = data.pinPolicy || {};
      const minDigits = policy.minDigits || 6;
      const maxDigits = policy.maxDigits || 8;
      pinPolicy = { minDigits, maxDigits };
      pairingHintEl.textContent = `対象Macの管理画面に表示されているPINを入力（推奨 ${minDigits}〜${maxDigits}桁）。`;
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
