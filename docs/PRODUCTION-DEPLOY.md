# KGS-PURCHASE Production Deployment

Production deployment for **KGS-PURCHASE** on the same Windows server as **kelin-connect-nextjs** (CMS), with isolated PM2 processes and nginx routing.

## URLs

| App | URL |
|-----|-----|
| CMS (kelin-connect) | `http://190.82.233.232/` |
| KGS Purchasing | `http://190.82.233.232/kgs-purchase` |

Use port **80** (nginx). Port **3001** is internal only — do not share `:3001` with users.

## Architecture

```
Internet / LAN
      │
      ▼
  nginx :80  (C:\nginx\conf\nginx.conf)
      │
      ├── /                    → CMS (PM2 kelin-connect-http, port 3000)
      ├── /HRISAPI/            → Apache :8080
      └── /kgs-purchase        → KGS (PM2 kgs-purchase-http, port 3001)
```

Both apps deploy independently. A push to one repo only restarts its own PM2 process.

| Resource | CMS | KGS-PURCHASE |
|----------|-----|--------------|
| Repo | kelin-connect-nextjs | `mis-jp/kgs-purchase` |
| Server path | `...\kelin-connect-nextjs\kelin-connect-nextjs` | `C:\Users\Administrator\Desktop\Github\KGS-PURCHASE` |
| Deploy branch | `master` | `main` |
| PM2 name | `kelin-connect-http` | `kgs-purchase-http` |
| Port | 3000 | 3001 |
| Base path | `/` | `/kgs-purchase` |

## Files added or changed

### GitHub Actions

- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) — self-hosted Windows deploy on push to `main` (mirrors CMS workflow)

### PM2 & scripts

| File | Purpose |
|------|---------|
| [`ecosystem.config.js`](../ecosystem.config.js) | PM2 config for `kgs-purchase-http` |
| [`scripts/ensure-pm2-env.ps1`](../scripts/ensure-pm2-env.ps1) | PM2 home directory fix for CI shells |
| [`scripts/pm2-env.bat`](../scripts/pm2-env.bat) | Batch wrapper for PM2 env |
| [`scripts/backup-next-build.ps1`](../scripts/backup-next-build.ps1) | Backup `.next` before deploy |
| [`scripts/restore-next-backup.ps1`](../scripts/restore-next-backup.ps1) | Rollback on failed deploy |
| [`scripts/copy-standalone-assets.ps1`](../scripts/copy-standalone-assets.ps1) | Copy static assets into standalone output |
| [`scripts/bootstrap-production.ps1`](../scripts/bootstrap-production.ps1) | First-time manual deploy |
| [`scripts/register-self-hosted-runner.ps1`](../scripts/register-self-hosted-runner.ps1) | Register GitHub Actions runner |
| [`scripts/setup-kgs-purchase-proxy.ps1`](../scripts/setup-kgs-purchase-proxy.ps1) | Patch nginx for `/kgs-purchase` routing |

### App config

| File | Change |
|------|--------|
| [`next.config.mjs`](../next.config.mjs) | `basePath` from `NEXT_PUBLIC_BASE_PATH` |
| [`lib/base-path.js`](../lib/base-path.js) | Path and cookie helpers |
| [`lib/api-client.js`](../lib/api-client.js) | Base-path-aware API URLs |
| Auth routes, sign-in, sidebar, exports | Base-path-aware redirects and cookies |
| [`package.json`](../package.json) | `next build --webpack` (Windows compatibility) |

### Nginx (server)

- **`C:\nginx\conf\nginx.conf`** — upstream `kgs_purchase` and `location ^~ /kgs-purchase`
- [`nginx/kgs-purchase-snippet.conf`](../nginx/kgs-purchase-snippet.conf) — reference snippet for the repo

### Deprecated (not used on Windows prod)

- [`deploy.sh`](../deploy.sh) — Linux manual deploy
- [`nginx.conf`](../nginx.conf) — Linux full-site config

## Environment variables

Create or update `.env` in the repo root (gitignored):

```env
NEXT_PUBLIC_BASE_PATH=/kgs-purchase
NEXT_PUBLIC_BASE_URL=http://190.82.233.232/kgs-purchase

# Acumatica
ACUMATICA_BASE_URL=...
ACU_USERNAME=...
ACU_PASSWORD=...
ACU_COMPANY=...

# MySQL
MYSQL_HOST=...
MYSQL_PORT=3306
MYSQL_USER=...
MYSQL_PASSWORD=...
MYSQL_PURCHASE_DATABASE=db_purchase
MYSQL_INVENTORY_DATABASE=db_kelin_inventory

# Optional
SYNC_SECRET=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SECRET_KEY=...
```

`ecosystem.config.js` loads `.env` via `dotenv` and passes variables to PM2.

## First-time setup

### 1. Install dependencies and build

```powershell
cd C:\Users\Administrator\Desktop\Github\KGS-PURCHASE
# Create .env with values above
.\scripts\bootstrap-production.ps1
```

### 2. Nginx routing (one-time)

If `/kgs-purchase` is not reachable on port 80, run as **Administrator**:

```powershell
.\scripts\setup-kgs-purchase-proxy.ps1
```

Then restart nginx if reload fails (access denied):

```powershell
taskkill /F /IM nginx.exe
cd C:\nginx
.\nginx.exe
```

### 3. GitHub Actions runner

Register a self-hosted runner for this repo (CMS runner is tied to kelin-connect only):

```powershell
.\scripts\register-self-hosted-runner.ps1 -OwnerRepo "mis-jp/kgs-purchase" -RunnerName "kgs-purchase-runner"
# Complete config.cmd with GitHub registration token
```

After that, pushing to **`main`** triggers automatic deploy.

## Deploy workflow (push to main)

1. `git fetch` / `git reset --hard origin/main`
2. Stop `kgs-purchase-http`, backup `.next` → `.next-backup`
3. `npm run build` (with `NEXT_PUBLIC_BASE_PATH=/kgs-purchase`)
4. Copy standalone assets
5. Verify `BUILD_ID` and `standalone/server.js`
6. `pm2 reload kgs-purchase-http`
7. Health check: `http://localhost:3001/kgs-purchase/signin`
8. On failure: restore backup and reload PM2

CMS (`kelin-connect-http`) is never stopped or restarted by this workflow.

### Sign-in / Cloudflare 502 (process hung)

`kgs-purchase-http` can stall or die under sync/MySQL load. When nothing answers on port 3001, Cloudflare returns 502.

A Task Scheduler watchdog probes `http://127.0.0.1:3001/kgs-purchase/api/health` every minute and force-restarts a dead or hung process:

```powershell
.\scripts\register-watchdog-task.ps1
```

Important settings:
- Max runtime **2 minutes** (so a stuck restart cannot block checks for hours)
- Overlapping runs are ignored
- Restart path does **not** call `ensure-node-path.ps1` (that scan can hang SYSTEM jobs)

Log: `C:\Users\Administrator\.pm2\logs\kgs-purchase-watchdog.log`. Pause during maintenance with a `.watchdog-pause` file in the repo root (deploys do this automatically).

## Manual PM2 commands

```powershell
cd C:\Users\Administrator\Desktop\Github\KGS-PURCHASE
pm2 list
pm2 logs kgs-purchase-http
pm2 reload kgs-purchase-http --update-env
pm2 restart kgs-purchase-http
```

## Troubleshooting

### `/kgs-purchase` shows CMS or blank page

Nginx is routing `/kgs-purchase` to CMS (port 3000) instead of KGS (3001).

- Confirm `C:\nginx\conf\nginx.conf` has `location ^~ /kgs-purchase` **before** `location /`
- Restart nginx (see above)
- Check HTML asset paths: should be `/kgs-purchase/_next/...`, not `/_next/...`

### `/kgs-purchase` shows “Kelin Connect is under maintenance”

`kgs-purchase-http` is down (or was never started), and nginx’s Kelin Connect `error_page` was applied at **server** scope so `/kgs-purchase` 502s showed the CMS maintenance HTML.

- Start the app: `pm2 start ecosystem.config.js --only kgs-purchase-http` then `pm2 save`
- Keep `error_page … /maintenance.html` only inside Kelin Connect `location /`, not server-wide
- Ensure `/kgs-purchase` has `proxy_intercept_errors off;` (see `nginx/kgs-purchase-snippet.conf` / `scripts/setup-kgs-purchase-proxy.ps1`)

### App works on localhost but not via public IP

- Use `http://190.82.233.232/kgs-purchase` (port 80), not `:3001`
- Ensure firewall/router allows inbound HTTP on port 80
- Server LAN IP is `192.168.0.101`; public IP `190.82.233.232` is NAT’d

### Build fails on Windows

- Use `npm ci` then `npm run build` (webpack mode)
- Set `NODE_OPTIONS=--max-old-space-size=8192` for large builds
- If `node_modules` is corrupt: delete `node_modules` and run `npm ci` again

### GitHub Actions deploy does not run

- Register a self-hosted runner for `mis-jp/kgs-purchase`
- Workflow uses `runs-on: self-hosted`

### CMS broken after nginx change

- CMS should still use `location /` → `upstream nextjs` (port 3000)
- Do not remove or reorder CMS locations
- Restore from `C:\nginx\conf\nginx.conf.bak.*` if needed

## Verification checklist

- [ ] `pm2 list` — both `kelin-connect-http` and `kgs-purchase-http` online
- [ ] `http://190.82.233.232/` — CMS loads
- [ ] `http://190.82.233.232/kgs-purchase` — KGS sign-in loads
- [ ] Browser devtools — CSS/JS load from `/kgs-purchase/_next/...`
- [ ] Push to `main` — only `kgs-purchase-http` restarts
