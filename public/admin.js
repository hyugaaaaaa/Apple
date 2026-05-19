'use strict';

const pinCodeEl = document.getElementById('pin-code');
const pinNoteEl = document.getElementById('pin-note');
const saveStatusEl = document.getElementById('save-status');
const saveBtn = document.getElementById('save-btn');
const headInfoBtn = document.getElementById('head-info');
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

const ITEMS_PER_PAGE = 8;
const MAX_PAGES = 3;
const MAX_REGISTERED_APPS = ITEMS_PER_PAGE * MAX_PAGES;

let apps = [];
let slotPaths = Array(MAX_REGISTERED_APPS).fill(null);
let page = 'apps';
let query = '';
let modalQuery = '';
let pinnedPage = 0;
let replaceSlotIndex = null;
let replaceCandidatePath = null;
let currentPin = '';

function setStatus(text, ok) {
  saveStatusEl.textContent = text;
  saveStatusEl.classList.remove('status-ok', 'status-ng');
  if (ok === true) saveStatusEl.classList.add('status-ok');
  if (ok === false) saveStatusEl.classList.add('status-ng');
}

function setPage(nextPage) {
  page = nextPage;
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

function selectedApps() {
  return apps.filter((a) => a.selected);
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
  appModalEl.setAttribute('aria-hidden', 'true');
}

function openModalForAdd() {
  replaceSlotIndex = null;
  replaceCandidatePath = null;
  if (modalTitleEl) modalTitleEl.textContent = 'アプリ一覧';
  clearSelectionBtn.textContent = 'このページをクリア';
  applySelectionBtn.textContent = '適用';
  showModal();
}

function openModalForReplace(slotIndex) {
  replaceSlotIndex = slotIndex;
  replaceCandidatePath = slotPaths[slotIndex] || null;
  if (modalTitleEl) modalTitleEl.textContent = 'アプリを再選択';
  clearSelectionBtn.textContent = 'この枠を解除';
  applySelectionBtn.textContent = '差し替え';
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

    btn.innerHTML = `
      <span class="icon-wrap">
        <img src="${app.iconUrl || ''}" alt="" />
      </span>
      <span class="pin-name">${shortName(app.name, 13)}</span>
    `;

    btn.addEventListener('click', () => {
      openModalForReplace(slotIndex);
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
      add.addEventListener('click', () => openModalForAdd());
      pinnedGridEl.appendChild(add);
    }
  }

  renderDots();
}

function renderModalList() {
  const list = filteredApps(modalQuery);
  modalListEl.innerHTML = '';
  const isReplaceMode = Number.isInteger(replaceSlotIndex);

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
    img.addEventListener('error', () => {
      img.style.visibility = 'hidden';
    });

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
  const res = await fetch('/api/admin/state', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.message || '状態の取得に失敗しました');

  apps = Array.isArray(data.apps) ? data.apps : [];
  slotPaths = normalizeSlotPaths(Array.isArray(data.selectedSlots) ? data.selectedSlots : data.selectedApps);
  syncSelectedFlagsFromSlots();

  currentPin = String(data.pin || '');
  pinCodeEl.textContent = data.requirePin ? currentPin : 'PIN無効';
  if (deviceNameEl) {
    deviceNameEl.textContent = `デバイス: ${data.deviceName || 'unknown'}`;
  }
  pinNoteEl.textContent = data.requirePin
    ? `iPhone側の認証画面でこのPINを入力してください（${data.pinSource === 'env' ? '固定PIN' : 'ローカルPIN'}）。`
    : '現在PIN認証は無効です (REQUIRE_PIN=false)。';
  if (data.weakPin) {
    pinNoteEl.textContent += ' 4桁PINは弱いため6〜8桁を推奨します。';
  }
  if (rotatePinBtn) {
    rotatePinBtn.disabled = false;
    rotatePinBtn.title = '新しいPINを発行';
  }

  renderPinned();
  setStatus(`読み込み完了: 全${apps.length}アプリ / 選択中 ${selectedCount()} / ${MAX_REGISTERED_APPS}`, true);
}

async function saveSelection() {
  const selectedApps = selectedPathsInSlotOrder().slice(0, MAX_REGISTERED_APPS);
  const selectedSlots = slotPaths.slice(0, MAX_REGISTERED_APPS);
  saveBtn.disabled = true;
  setStatus('保存中...', null);

  try {
    const res = await fetch('/api/admin/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedApps, selectedSlots })
    });
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
      method: 'POST'
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }

    currentPin = String(data.pin || '');
    pinCodeEl.textContent = currentPin;
    pinNoteEl.textContent = 'PINを再発行しました。iPhone側で新しいPINを入力してください。';
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

headInfoBtn.addEventListener('click', () => {
  setPage('about');
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

loadState().catch((err) => {
  setStatus(`読み込み失敗: ${err.message}`, false);
});
