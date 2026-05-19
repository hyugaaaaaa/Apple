# Cloudflare Deploy Guide

## 1. Prerequisites
- macOS machine where this project runs continuously.
- Node.js already installed (this project currently uses `/Users/hyuga/node/bin/node`).
- Cloudflare account and a managed domain.
- `cloudflared` installed.

```bash
brew install cloudflared
cloudflared tunnel login
```

## 2. Create tunnel once
```bash
cloudflared tunnel create left-controller
```

This generates credentials json under `~/.cloudflared/`.

## 3. Generate project deploy config
Run from project root:

```bash
npm run deploy:prepare -- \
  --domain controller.example.com \
  --credentials-file /Users/<your-user>/.cloudflared/<TUNNEL-UUID>.json \
  --tunnel-name left-controller
```

Generated files:
- `deploy/cloudflared-config.yml`
- `launchd/com.hyuga.leftcontroller.cloudflared.plist`

## 4. Bind DNS to tunnel
```bash
cloudflared tunnel route dns left-controller controller.example.com
```

## 5. Install background services (launchd)
```bash
npm run deploy:install
```

This loads and starts:
- `com.hyuga.leftcontroller` (Node.js controller server)
- `com.hyuga.leftcontroller.cloudflared` (Cloudflare tunnel)

## 6. Verify deployment status
```bash
npm run deploy:status
```

Also verify in browser:
- `https://controller.example.com/admin.html`
- `https://controller.example.com/auth.html`
- `https://controller.example.com/controller.html`

## 7. Recommended production security
- Protect `/admin.html` by Cloudflare Access policy.
- Keep PIN authentication enabled on the app side.
- Use Cloudflare Access as first gate, PIN as second gate.

## Runtime behavior already implemented in app
- WebSocket endpoint auto-resolves host/protocol (`ws`/`wss`) from current URL.
- No fixed `localhost:8080` in hosted mode.
- Runtime debug UI flag available via `/api/runtime`.
- Production mode hides debug blocks (`NODE_ENV=production`, `DEBUG_UI=false`).
