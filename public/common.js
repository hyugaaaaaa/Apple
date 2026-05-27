'use strict';

// Shared utilities for auth.js / controller.js / admin.js
// Must be loaded before those scripts.

window.LeftController = window.LeftController || {};

(function (ns) {
  const DEVICE_ID_STORAGE_KEY = 'left_controller_device_id';

  // NOTE: Must match relay/broker.js (ITEMS_PER_PAGE, MAX_PAGES, MAX_COMMANDS).
  const LIMITS = Object.freeze({
    itemsPerPage: 8,
    pages: 3,
    maxCommands: 8 * 3
  });

  function resolveWsUrl() {
    if (window.location.protocol === 'file:') {
      return 'ws://localhost:8080';
    }
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${window.location.host}`;
  }

  function getOrCreateDeviceId() {
    const current = localStorage.getItem(DEVICE_ID_STORAGE_KEY) || '';
    if (current) return current;
    let next = '';
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      next = window.crypto.randomUUID();
    } else {
      next = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, next);
    return next;
  }

  function buildDeviceName() {
    const ua = navigator.userAgent || '';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Android/i.test(ua)) return 'Android';
    if (/Mac/i.test(ua)) return 'Mac Browser';
    return 'Browser Device';
  }

  ns.DEVICE_ID_STORAGE_KEY = DEVICE_ID_STORAGE_KEY;
  ns.LIMITS = LIMITS;
  ns.resolveWsUrl = resolveWsUrl;
  ns.getOrCreateDeviceId = getOrCreateDeviceId;
  ns.buildDeviceName = buildDeviceName;
})(window.LeftController);
