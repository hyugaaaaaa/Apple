# iPhone Mac Left Controller

## Cloudflare deployment quick start
1. `cd /Users/hyuga/iphone-mac-left-controller`
2. `npm install`
3. `cloudflared tunnel login`
4. `cloudflared tunnel create left-controller`
5. `npm run deploy:prepare -- --domain <your-domain> --credentials-file <path-to-json> --tunnel-name left-controller`
6. `cloudflared tunnel route dns left-controller <your-domain>`
7. `npm run deploy:install`
8. `npm run deploy:status`

Detailed guide: `/Users/hyuga/iphone-mac-left-controller/deploy/CLOUDFLARE_DEPLOY.md`
