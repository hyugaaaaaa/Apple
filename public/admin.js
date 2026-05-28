'use strict';

const ADMIN_TOKEN_KEY = 'left_controller_admin_token';
const ADMIN_TOKEN_EXPIRES_KEY = 'left_controller_admin_token_expires';
const ADMIN_MAC_ID_KEY = 'left_controller_admin_mac_id';

function getAdminToken() {
  const token = sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  const expiresAt = Number(sessionStorage.getItem(ADMIN_TOKEN_EXPIRES_KEY) || '0');
  if (!token) return '';
  if (expiresAt && Date.now() >= expiresAt) {
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    sessionStorage.removeItem(ADMIN_TOKEN_EXPIRES_KEY);
    sessionStorage.removeItem(ADMIN_MAC_ID_KEY);
    return '';
  }
  return token;
}

function setAdminToken(token, expiresAt, macId) {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  sessionStorage.setItem(ADMIN_TOKEN_EXPIRES_KEY, String(expiresAt || 0));
  if (macId) sessionStorage.setItem(ADMIN_MAC_ID_KEY, macId);
}

function adminAuthHeaders() {
  const token = getAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function showAdminLoginModal() {
  const el = document.getElementById('admin-login-modal');
  if (el) { el.removeAttribute('hidden'); el.style.display = 'flex'; }
  const input = document.getElementById('admin-login-pin');
  if (input) input.focus();
}

function hideAdminLoginModal() {
  const el = document.getElementById('admin-login-modal');
  if (el) { el.setAttribute('hidden', ''); el.style.display = 'none'; }
}

async function submitAdminLogin() {
  const input = document.getElementById('admin-login-pin');
  const errEl = document.getElementById('admin-login-error');
  const submitBtn = document.getElementById('admin-login-submit');
  const pin = (input ? input.value : '').trim();
  if (!pin) return;

  if (errEl) errEl.textContent = '';
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json().catch(() => ({}));

    if (data.ok && data.token) {
      setAdminToken(data.token, data.expiresAt, data.macId);
      hideAdminLoginModal();
      if (input) input.value = '';
      loadState().catch(() => {});
    } else {
      if (errEl) errEl.textContent = data.message === 'invalid_pin' ? 'PINが正しくありません' : (data.message || 'ログイン失敗');
    }
  } catch (err) {
    if (errEl) errEl.textContent = `エラー: ${err.message}`;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ── PIN 回復 ──────────────────────────────────────────────
const SETUP_DEVICE_ID_KEY = 'left_controller_setup_device_id';

function showPinRecovery() {
  const formEl = document.getElementById('login-form-section');
  const recEl  = document.getElementById('pin-recovery-section');
  const devRow = document.getElementById('pin-recovery-device-row');
  const errEl  = document.getElementById('pin-recovery-error');
  const resEl  = document.getElementById('pin-recovery-result');

  if (formEl) formEl.style.display = 'none';
  if (recEl)  recEl.style.display  = 'flex';
  if (errEl)  errEl.textContent    = '';
  if (resEl)  resEl.style.display  = 'none';

  const storedId = localStorage.getItem(SETUP_DEVICE_ID_KEY) || '';
  if (storedId) {
    // デバイスIDが保存済み → 入力欄を隠して自動フェッチ
    if (devRow) devRow.style.display = 'none';
    fetchRecoveryPin();
  } else {
    // デバイスIDが不明 → 入力欄を表示
    if (devRow) devRow.style.display = 'flex';
    const inp = document.getElementById('pin-recovery-device-input');
    if (inp) inp.focus();
  }
}

function hidePinRecovery() {
  const formEl = document.getElementById('login-form-section');
  const recEl  = document.getElementById('pin-recovery-section');
  if (formEl) formEl.style.display = 'flex';
  if (recEl)  recEl.style.display  = 'none';
}

async function fetchRecoveryPin() {
  const btn    = document.getElementById('pin-recovery-btn');
  const errEl  = document.getElementById('pin-recovery-error');
  const resEl  = document.getElementById('pin-recovery-result');
  const valEl  = document.getElementById('pin-recovery-value');
  const devRow = document.getElementById('pin-recovery-device-row');

  if (errEl) errEl.textContent = '';
  if (resEl) resEl.style.display = 'none';
  if (btn)   btn.disabled = true;

  // デバイスID: localStorage優先、なければ入力欄の値
  let deviceId = localStorage.getItem(SETUP_DEVICE_ID_KEY) || '';
  if (!deviceId) {
    const inp = document.getElementById('pin-recovery-device-input');
    deviceId = (inp ? inp.value : '').trim();
  }

  if (!deviceId) {
    if (errEl) errEl.textContent = 'デバイスIDを入力してください';
    if (devRow) devRow.style.display = 'flex';
    if (btn) btn.disabled = false;
    return;
  }

  try {
    const data = await fetch(
      `/api/health?deviceId=${encodeURIComponent(deviceId)}`,
      { cache: 'no-store' }
    ).then(r => r.json());

    const online = Array.isArray(data.agentsOnline) &&
      data.agentsOnline.some(a => a.macId === deviceId);

    if (online && data.pin) {
      if (valEl) valEl.textContent = data.pin;
      if (resEl) resEl.style.display = 'flex';
    } else if (!online) {
      if (errEl) errEl.textContent = 'Macがオフラインです。Macでエージェントを起動してから再試行してください。';
      // デバイスID入力欄を表示して別のIDも試せるように
      if (devRow) devRow.style.display = 'flex';
    } else {
      if (errEl) errEl.textContent = 'PINを取得できませんでした。';
    }
  } catch (err) {
    if (errEl) errEl.textContent = `エラー: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function copyRecoveryPin() {
  const valEl  = document.getElementById('pin-recovery-value');
  const copyBtn = document.getElementById('pin-recovery-copy');
  const pin = valEl ? valEl.textContent.trim() : '';
  if (!pin) return;
  navigator.clipboard.writeText(pin).then(() => {
    if (copyBtn) { copyBtn.textContent = 'コピー済み ✓'; }
    setTimeout(() => { if (copyBtn) copyBtn.textContent = 'コピー'; }, 2000);
  });
}

window.showPinRecovery = showPinRecovery;
window.hidePinRecovery = hidePinRecovery;
window.fetchRecoveryPin = fetchRecoveryPin;
window.copyRecoveryPin = copyRecoveryPin;
// ─────────────────────────────────────────────────────────

const pinCodeEl = document.getElementById('pin-code');
const pinNoteEl = document.getElementById('pin-note');
const saveStatusEl = document.getElementById('save-status');
const saveBtn = document.getElementById('save-btn');
const headTitleEl = document.getElementById('head-title');

const tabAppsBtn = document.getElementById('tab-apps');
const tabAboutBtn = document.getElementById('tab-about');
const viewAppsEl = document.getElementById('view-apps');
const viewAboutEl = document.getElementById('view-about');

const searchInputEl = document.getElementById('search-input');
const pinnedGridEl = document.getElementById('pinned-grid');
const pageDotsEl = document.getElementById('page-dots');

const appModalEl = document.getElementById('app-modal');
const closeModalBtn = document.getElementById('close-modal');
const modalSearchEl = document.getElementById('modal-search');
const modalListEl = document.getElementById('modal-list');
const clearSelectionBtn = document.getElementById('clear-selection');
const applySelectionBtn = document.getElementById('apply-selection');
const modalTitleEl = document.querySelector('.modal-top span');
const deviceNameEl = document.getElementById('device-name');
const copyPinBtn = document.getElementById('copy-pin-btn');
const rotatePinBtn = document.getElementById('rotate-pin-btn');

const ITEMS_PER_PAGE = window.LeftController.LIMITS.itemsPerPage;
const MAX_PAGES = window.LeftController.LIMITS.pages;
const MAX_REGISTERED_APPS = window.LeftController.LIMITS.maxCommands;

let apps = [];
let slotPaths = Array(MAX_REGISTERED_APPS).fill(null);
let query = '';
let modalQuery = '';
let pinnedPage = 0;
let replaceSlotIndex = null;
let replaceCandidatePath = null;
let currentPin = '';
let lastStateLoadedAt = 0;
let stateRecoveryTimer = null;

const myDeviceId = window.LeftController.getOrCreateDeviceId();
const myDeviceName = window.LeftController.buildDeviceName();

function fallbackIconDataUrl(name) {
  const letter = (String(name || 'A').trim().charAt(0) || 'A').toUpperCase();
  const safeLetter = letter.replace(/[<>&"']/g, '');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#2a2d35" />
      <stop offset="1" stop-color="#101114" />
    </linearGradient>
  </defs>
  <rect x="2" y="2" rx="22" ry="22" width="92" height="92" fill="url(#g)" />
  <text x="48" y="58" text-anchor="middle" font-size="44" fill="#f3eee7" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">${safeLetter}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function attachFallbackIcon(img, appName) {
  const fallbackUrl = fallbackIconDataUrl(appName);
  const onError = () => {
    if (img.dataset.fallbackApplied === '1') return;
    img.dataset.fallbackApplied = '1';
    img.src = fallbackUrl;
  };
  img.addEventListener('error', onError);
}

function setStatus(text, ok) {
  saveStatusEl.textContent = text;
  saveStatusEl.classList.remove('status-ok', 'status-ng');
  if (ok === true) saveStatusEl.classList.add('status-ok');
  if (ok === false) saveStatusEl.classList.add('status-ng');
}

function clearStateRecoveryTimer() {
  if (!stateRecoveryTimer) return;
  clearTimeout(stateRecoveryTimer);
  stateRecoveryTimer = null;
}

function scheduleStateRecovery() {
  if (stateRecoveryTimer) return;
  stateRecoveryTimer = setTimeout(async () => {
    stateRecoveryTimer = null;
    try {
      await loadState();
    } catch {
      // keep retrying while the page stays open
    }
  }, 3000);
}

function setPage(nextPage) {
  const appsActive = nextPage === 'apps';
  tabAppsBtn.classList.toggle('active', appsActive);
  tabAboutBtn.classList.toggle('active', !appsActive);
  viewAppsEl.classList.toggle('active', appsActive);
  viewAboutEl.classList.toggle('active', !appsActive);
  headTitleEl.textContent = appsActive ? '登録アプリ' : '情報';
}


function shortName(name, max = 12) {
  if (name.length <= max) return name;
  return `${name.slice(0, max - 1)}…`;
}

function filteredApps(baseQuery) {
  const q = (baseQuery || '').trim().toLowerCase();
  if (!q) return apps;
  return apps.filter((a) => a.name.toLowerCase().includes(q));
}

function selectedCount() {
  let count = 0;
  for (const p of slotPaths) {
    if (p) count += 1;
  }
  return count;
}

async function copyTextSafe(text) {
  const value = String(text || '');
  if (!value) return false;

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  return ok;
}

function normalizeSlotPaths(paths) {
  const cleaned = (Array.isArray(paths) ? paths : [])
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .slice(0, MAX_REGISTERED_APPS);
  const unique = [];
  const seen = new Set();
  for (const p of cleaned) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }
  const slots = Array(MAX_REGISTERED_APPS).fill(null);
  unique.forEach((p, idx) => {
    slots[idx] = p;
  });
  return slots;
}

function selectedPathsInSlotOrder() {
  return slotPaths.filter(Boolean);
}

function syncSelectedFlagsFromSlots() {
  const selectedSet = new Set(selectedPathsInSlotOrder());
  apps = apps.map((a) => ({ ...a, selected: selectedSet.has(a.path) }));
}

function findSlotIndexByPath(path) {
  return slotPaths.findIndex((p) => p === path);
}

function pageBounds(pageIndex) {
  const start = pageIndex * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  return { start, end };
}

function firstEmptySlotOnPage(pageIndex) {
  const { start, end } = pageBounds(pageIndex);
  for (let i = start; i < end; i += 1) {
    if (!slotPaths[i]) return i;
  }
  return -1;
}

function setSlotPath(slotIndex, nextPath) {
  if (slotIndex < 0 || slotIndex >= MAX_REGISTERED_APPS) return false;

  const path = nextPath ? String(nextPath).trim() : null;
  if (!path) {
    slotPaths[slotIndex] = null;
    syncSelectedFlagsFromSlots();
    return true;
  }

  const existingIndex = findSlotIndexByPath(path);
  if (existingIndex >= 0 && existingIndex !== slotIndex) {
    slotPaths[existingIndex] = null;
  }

  slotPaths[slotIndex] = path;
  syncSelectedFlagsFromSlots();
  return true;
}

function removePathFromSlots(path) {
  const index = findSlotIndexByPath(path);
  if (index < 0) return false;
  slotPaths[index] = null;
  syncSelectedFlagsFromSlots();
  return true;
}

function renderDots() {
  let usedPages = 1;
  for (let i = MAX_PAGES - 1; i >= 0; i -= 1) {
    const { start, end } = pageBounds(i);
    const hasData = slotPaths.slice(start, end).some(Boolean);
    if (hasData) {
      usedPages = i + 1;
      break;
    }
  }

  if (pinnedPage >= MAX_PAGES) pinnedPage = MAX_PAGES - 1;

  pageDotsEl.innerHTML = '';
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const d = document.createElement('button');
    d.type = 'button';
    d.classList.add('dot-btn');
    if (i < usedPages) d.classList.add('active');
    if (i === pinnedPage) d.classList.add('current');
    d.title = `${i + 1}ページ`;
    d.addEventListener('click', () => {
      pinnedPage = i;
      renderPinned();
    });
    pageDotsEl.appendChild(d);
  }
}

function showModal() {
  appModalEl.classList.add('show');
  appModalEl.setAttribute('aria-hidden', 'false');
  modalSearchEl.value = '';
  modalQuery = '';
  renderModalList();
}

function closeModal() {
  replaceSlotIndex = null;
  replaceCandidatePath = null;
  appModalEl.classList.remove('show');
  if (appModalEl.contains(document.activeElement)) {
    document.activeElement.blur();
  }
  appModalEl.setAttribute('aria-hidden', 'true');
}

function openModalForAdd() {
  replaceSlotIndex = null;
  replaceCandidatePath = null;
  if (modalTitleEl) modalTitleEl.textContent = 'アプリ一覧';
  clearSelectionBtn.textContent = 'このページをクリア';
  applySelectionBtn.textContent = '適用';
  void ensureAppsReadyForModal();
  showModal();
}

function openModalForReplace(slotIndex) {
  replaceSlotIndex = slotIndex;
  replaceCandidatePath = slotPaths[slotIndex] || null;
  if (modalTitleEl) modalTitleEl.textContent = 'アプリを再選択';
  clearSelectionBtn.textContent = 'この枠を解除';
  applySelectionBtn.textContent = '差し替え';
  void ensureAppsReadyForModal();
  showModal();
}

function renderPinned() {
  const filteredSet = new Set(filteredApps(query).map((a) => a.path));
  const hasQuery = query.trim().length > 0;
  const totalSelected = selectedCount();

  pinnedGridEl.innerHTML = '';

  const { start, end } = pageBounds(pinnedPage);
  for (let slotIndex = start; slotIndex < end; slotIndex += 1) {
    const path = slotPaths[slotIndex];
    if (!path) continue;
    if (hasQuery && !filteredSet.has(path)) continue;

    const app = apps.find((a) => a.path === path);
    if (!app) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pin-tile';
    btn.dataset.path = app.path;
    btn.dataset.slot = String(slotIndex);
    btn.title = `${app.name} (クリックで再選択)`;

    const wrap = document.createElement('span');
    wrap.className = 'icon-wrap';

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.src = app.iconUrl || fallbackIconDataUrl(app.name);
    attachFallbackIcon(img, app.name);
    wrap.appendChild(img);

    const label = document.createElement('span');
    label.className = 'pin-name';
    label.textContent = shortName(app.name, 13);

    btn.appendChild(wrap);
    btn.appendChild(label);

    btn.addEventListener('click', () => {
      void openModalForReplace(slotIndex);
    });

    pinnedGridEl.appendChild(btn);
  }

  if (!query.trim()) {
    const emptySlot = firstEmptySlotOnPage(pinnedPage);
    if (emptySlot >= 0 && totalSelected < MAX_REGISTERED_APPS) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pin-tile add';
      add.innerHTML = `
        <span class="icon-wrap"><span class="plus">+</span></span>
        <span class="pin-name">追加</span>
      `;
      add.addEventListener('click', () => void openModalForAdd());
      pinnedGridEl.appendChild(add);
    }
  }

  renderDots();
}

function renderModalList() {
  const list = filteredApps(modalQuery);
  modalListEl.innerHTML = '';
  const isReplaceMode = Number.isInteger(replaceSlotIndex);

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'modal-empty';
    empty.style.gridColumn = '1 / -1';
    empty.style.display = 'grid';
    empty.style.gap = '10px';
    empty.style.alignContent = 'center';
    empty.style.justifyItems = 'start';
    empty.style.padding = '10px 6px';

    const text = document.createElement('div');
    text.textContent = apps.length === 0
      ? 'アプリ一覧を読み込めませんでした。'
      : '一致するアプリがありません。';
    text.style.color = '#d5cec6';
    text.style.fontSize = '14px';

    empty.appendChild(text);

    if (apps.length === 0) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'head-btn';
      retry.textContent = '再読み込み';
      retry.addEventListener('click', () => {
        void ensureAppsReadyForModal(true);
      });
      empty.appendChild(retry);
    }

    modalListEl.appendChild(empty);
    return;
  }

  list.forEach((app) => {
    const row = document.createElement('label');
    row.className = 'modal-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = app.path;

    if (isReplaceMode) {
      const slotPath = slotPaths[replaceSlotIndex];
      const selectedElsewhere = app.selected && app.path !== slotPath;
      cb.checked = replaceCandidatePath === app.path;
      cb.disabled = selectedElsewhere;
      cb.addEventListener('change', () => {
        if (cb.checked) {
          replaceCandidatePath = app.path;
        } else if (replaceCandidatePath === app.path) {
          replaceCandidatePath = null;
        }
        renderModalList();
      });
    } else {
      cb.checked = app.selected;
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (app.selected) return;
          const slotIndex = firstEmptySlotOnPage(pinnedPage);
          if (slotIndex < 0) {
            cb.checked = false;
            setStatus(`このページは${ITEMS_PER_PAGE}件で満杯です`, false);
            return;
          }
          setSlotPath(slotIndex, app.path);
          setStatus(`選択中: ${selectedCount()} / ${MAX_REGISTERED_APPS}`, true);
          renderPinned();
          return;
        }

        removePathFromSlots(app.path);
        setStatus(`選択中: ${selectedCount()} / ${MAX_REGISTERED_APPS}`, true);
        renderPinned();
      });
    }

    const img = document.createElement('img');
    img.src = app.iconUrl || '';
    img.alt = '';
    img.loading = 'lazy';
    attachFallbackIcon(img, app.name);

    const text = document.createElement('span');
    text.textContent = app.name;

    row.appendChild(cb);
    row.appendChild(img);
    row.appendChild(text);
    modalListEl.appendChild(row);
  });
}

function applyReplaceSelection() {
  if (!Number.isInteger(replaceSlotIndex)) return;

  if (!replaceCandidatePath) {
    setSlotPath(replaceSlotIndex, null);
    setStatus('枠のアプリを解除しました', true);
    return;
  }

  const oldPath = slotPaths[replaceSlotIndex];
  if (replaceCandidatePath === oldPath) {
    setStatus('同じアプリのため変更なし', true);
    return;
  }

  const candidate = apps.find((a) => a.path === replaceCandidatePath);
  if (!candidate) {
    setStatus('差し替え先アプリが見つかりませんでした', false);
    return;
  }

  setSlotPath(replaceSlotIndex, replaceCandidatePath);
  setStatus(`${candidate.name} に差し替えました`, true);
}

async function loadState() {
  // トークンがなければ 401 を出さずにそのままログインモーダルを表示する
  if (!getAdminToken()) {
    showAdminLoginModal();
    return;
  }
  const qs = new URLSearchParams({
    deviceId: myDeviceId,
    deviceName: myDeviceName
  });
  const res = await fetch(`/api/admin/state?${qs.toString()}`, {
    cache: 'no-store',
    headers: adminAuthHeaders()
  });
  if (res.status === 401) {
    // サーバー再起動などでトークンが無効化された場合も含め、常にログインモーダルを表示
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    sessionStorage.removeItem(ADMIN_TOKEN_EXPIRES_KEY);
    sessionStorage.removeItem(ADMIN_MAC_ID_KEY);
    showAdminLoginModal();
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || '状態の取得に失敗しました');

  // 認証済みで状態が取得できた場合はログインモーダルを確実に閉じる
  hideAdminLoginModal();

  apps = Array.isArray(data.apps) ? data.apps : [];
  slotPaths = normalizeSlotPaths(Array.isArray(data.selectedSlots) ? data.selectedSlots : []);
  syncSelectedFlagsFromSlots();

  currentPin = String(data.pin || '');
  pinCodeEl.textContent = data.requirePin ? currentPin : 'PIN無効';
  if (deviceNameEl) {
    deviceNameEl.textContent = `デバイス: ${data.deviceName || 'unknown'}`;
  }
  pinNoteEl.textContent = data.requirePin
    ? 'このMac専用PINです。スマホの認証画面に入力してください。'
    : '現在PIN認証は無効です (REQUIRE_PIN=false)。';
  if (data.weakPin) {
    pinNoteEl.textContent += ' 4桁PINは弱いため6〜8桁を推奨します。';
  }
  if (rotatePinBtn) {
    rotatePinBtn.disabled = false;
    rotatePinBtn.title = '新しいPINを発行';
  }

  renderPinned();
  lastStateLoadedAt = Date.now();
  setStatus(`読み込み完了: 全${apps.length}アプリ / 選択中 ${selectedCount()} / ${MAX_REGISTERED_APPS}`, true);
  if (data.agentOnline === false) {
    setStatus('Macエージェント未接続です。管理内容は表示できますが実行にはエージェント接続が必要です。', false);
    scheduleStateRecovery();
    return;
  }
  if (apps.length === 0) {
    setStatus('アプリ一覧の取得待機中です。数秒後に自動再取得します。', false);
    scheduleStateRecovery();
    return;
  }
  clearStateRecoveryTimer();
}

async function ensureAppsReadyForModal(force = false) {
  const stale = (Date.now() - lastStateLoadedAt) > 15000;
  if (!force && apps.length > 0 && !stale) {
    renderModalList();
    return;
  }
  try {
    await loadState();
  } catch (err) {
    setStatus(`読み込み失敗: ${err.message}`, false);
  } finally {
    renderModalList();
  }
}

async function saveSelection() {
  const selectedSlots = slotPaths.slice(0, MAX_REGISTERED_APPS);
  saveBtn.disabled = true;
  setStatus('保存中...', null);

  try {
    const res = await fetch('/api/admin/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminAuthHeaders() },
      body: JSON.stringify({ selectedSlots })
    });
    if (res.status === 401) {
      showAdminLoginModal();
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    setStatus(`保存しました (${data.count}件 / 上限${MAX_REGISTERED_APPS})`, true);
  } catch (err) {
    setStatus(`保存失敗: ${err.message}`, false);
  } finally {
    saveBtn.disabled = false;
  }
}

async function rotatePin() {
  if (!rotatePinBtn) return;
  rotatePinBtn.disabled = true;
  setStatus('PIN再発行中...', null);

  try {
    const res = await fetch('/api/admin/pin/rotate', {
      method: 'POST',
      headers: adminAuthHeaders()
    });
    if (res.status === 401) {
      showAdminLoginModal();
      rotatePinBtn.disabled = false;
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }

    currentPin = String(data.pin || '');
    pinCodeEl.textContent = currentPin;
    pinNoteEl.textContent = '共通PINを再発行しました。端末側で再度PIN取得してください。';
    if (deviceNameEl) {
      deviceNameEl.textContent = `デバイス: ${data.deviceName || 'unknown'}`;
    }
    setStatus(`PIN更新: ${currentPin}`, true);
  } catch (err) {
    setStatus(`PIN再発行失敗: ${err.message}`, false);
  } finally {
    rotatePinBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', () => {
  saveSelection();
});

tabAppsBtn.addEventListener('click', () => {
  setPage('apps');
});

tabAboutBtn.addEventListener('click', () => {
  setPage('about');
});

if (searchInputEl) {
  searchInputEl.addEventListener('input', () => {
    query = searchInputEl.value || '';
    renderPinned();
  });
}

closeModalBtn.addEventListener('click', () => {
  closeModal();
});

appModalEl.addEventListener('click', (event) => {
  if (event.target === appModalEl) closeModal();
});

if (modalSearchEl) {
  modalSearchEl.addEventListener('input', () => {
    modalQuery = modalSearchEl.value || '';
    renderModalList();
  });
}

clearSelectionBtn.addEventListener('click', () => {
  if (Number.isInteger(replaceSlotIndex)) {
    setSlotPath(replaceSlotIndex, null);
    setStatus('枠のアプリを解除しました', true);
    renderPinned();
    closeModal();
    return;
  }

  const { start, end } = pageBounds(pinnedPage);
  for (let i = start; i < end; i += 1) {
    slotPaths[i] = null;
  }
  syncSelectedFlagsFromSlots();
  setStatus(`選択中: ${selectedCount()} / ${MAX_REGISTERED_APPS}`, true);
  renderModalList();
  renderPinned();
});

applySelectionBtn.addEventListener('click', () => {
  if (Number.isInteger(replaceSlotIndex)) {
    applyReplaceSelection();
    renderPinned();
    closeModal();
    return;
  }

  setStatus(`選択中: ${selectedCount()} / ${MAX_REGISTERED_APPS}`, true);
  closeModal();
});

if (copyPinBtn) {
  copyPinBtn.addEventListener('click', async () => {
    if (!currentPin) {
      setStatus('PINが未取得です', false);
      return;
    }
    try {
      const ok = await copyTextSafe(currentPin);
      if (!ok) {
        throw new Error('copy command unavailable');
      }
      setStatus('PINをコピーしました', true);
    } catch (err) {
      window.prompt('コピーできなかったため、手動でコピーしてください:', currentPin);
      setStatus(`コピー失敗: ${err.message}`, false);
    }
  });
}

if (rotatePinBtn) {
  rotatePinBtn.addEventListener('click', () => {
    rotatePin();
  });
}

const adminLoginSubmitBtn = document.getElementById('admin-login-submit');
const adminLoginPinInput = document.getElementById('admin-login-pin');

if (adminLoginSubmitBtn) {
  adminLoginSubmitBtn.addEventListener('click', () => {
    submitAdminLogin();
  });
}

if (adminLoginPinInput) {
  adminLoginPinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAdminLogin();
    const errEl = document.getElementById('admin-login-error');
    if (errEl) errEl.textContent = '';
  });
}

loadState().catch((err) => {
  const isWorkers = /\.workers\.dev$/i.test(window.location.hostname || '');
  if (isWorkers) {
    setStatus('workers.devは管理APIを持たないため、Tunnel管理URLへリダイレクト設定が必要です。', false);
    return;
  }
  setStatus(`読み込み失敗: ${err.message}`, false);
});
