'use strict';

const CACHE_VERSION = 'v56';
const CACHE_NAME = `left-controller-cache-${CACHE_VERSION}`;
const APP_SHELL = [
  '/',
  '/index.html',
  '/lp-onboarding.html',
  '/auth.html',
  '/controller.html',
  '/admin.html',
  '/style.css',
  '/controller-layout.css',
  '/controller-orientation.css',
  '/auth.js',
  '/controller.js',
  '/admin.js',
  '/manifest.json',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;

      if (req.mode === 'navigate') {
        const lpCache = await caches.match('/lp-onboarding.html');
        if (lpCache) return lpCache;
      }

      return new Response('Offline and no cache available', { status: 503 });
    }
  })());
});
