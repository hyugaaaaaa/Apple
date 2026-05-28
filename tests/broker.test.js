'use strict';

/* eslint-env node */

// Smoke tests for relay/broker.js — exercises the main HTTP API surface
// without external dependencies. Run with: `npm test`.
//
// Strategy: spawn broker.js as a subprocess on a free port, hit endpoints
// with the built-in http module, assert response status / shape, then kill.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.BROKER_TEST_PORT || 18080);
const STATE_PATH = path.join(os.tmpdir(), `broker-test-state-${Date.now()}.json`);

let serverProcess = null;

function request(method, urlPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: 'localhost',
        port: PORT,
        path: urlPath,
        headers: {
          ...(data
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
            : {}),
          ...(headers || {})
        }
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => { buf += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await request('GET', '/api/runtime');
      if (r.status === 200) return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('broker.js did not become ready within timeout');
}

before(async () => {
  serverProcess = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'relay', 'broker.js')],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        AGENT_TOKEN: 'test-agent-token',
        APP_PIN: '654321',
        DEFAULT_MAC_ID: 'test-mac',
        REQUIRE_PIN: 'true',
        RELAY_DATA_PATH: STATE_PATH
      },
      stdio: ['ignore', 'ignore', 'ignore']
    }
  );
  await waitForServer();
});

after(() => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  try { fs.unlinkSync(STATE_PATH); } catch { /* ignore */ }
});

test('GET /api/runtime returns ok with shape', async () => {
  const r = await request('GET', '/api/runtime');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('GET /api/pairing returns PIN policy and requirePin', async () => {
  const r = await request('GET', '/api/pairing?deviceId=test');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.requirePin, true);
  assert.ok(r.json.pinPolicy, 'should return pinPolicy');
  assert.ok(r.json.pinPolicy.minDigits >= 4);
});

test('GET /api/admin/state without token returns 401', async () => {
  const r = await request('GET', '/api/admin/state?deviceId=test');
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
});

test('POST /api/admin/commands without token returns 401', async () => {
  const r = await request('POST', '/api/admin/commands', { body: { selectedSlots: [] } });
  assert.equal(r.status, 401);
});

test('POST /api/admin/login with wrong PIN returns 401', async () => {
  const r = await request('POST', '/api/admin/login', { body: { pin: '999999' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.message, 'invalid_pin');
});

test('POST /api/admin/login with correct PIN returns token', async () => {
  const r = await request('POST', '/api/admin/login', { body: { pin: '654321' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.token, 'token should be present');
  assert.equal(r.json.macId, 'test-mac');
});

test('Authenticated /api/admin/state returns config', async () => {
  const login = await request('POST', '/api/admin/login', { body: { pin: '654321' } });
  const token = login.json.token;
  const r = await request('GET', '/api/admin/state?deviceId=test-mac', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.selectedSlots), 'selectedSlots array');
  // Confirm legacy selectedApps field has been removed (Step 7 unification)
  assert.equal(r.json.selectedApps, undefined);
  // Agent version tracking fields are present
  assert.ok('latestAgentVersion' in r.json, 'latestAgentVersion present');
  assert.match(r.json.latestAgentVersion, /^\d{8}-\d+$/);
  // No agent connected in this test → not flagged outdated
  assert.equal(r.json.agentOutdated, false);
});

test('GET /sw.js injects build cache version', async () => {
  const r = await request('GET', '/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.body, /const CACHE_VERSION = 'build-/);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('GET /lp-shared.css is served', async () => {
  const r = await request('GET', '/lp-shared.css');
  assert.equal(r.status, 200);
  assert.match(r.body, /lp-modal-overlay|--lp-bg/);
});

test('Unknown path returns 404', async () => {
  const r = await request('GET', '/this-file-does-not-exist.html');
  assert.equal(r.status, 404);
});

test('Path traversal is rejected', async () => {
  const r = await request('GET', '/%2e%2e%2fetc%2fpasswd');
  assert.notEqual(r.status, 200);
});
