# Web Inventory access bridge (same admin as the Flutter app)

Give the KelinConnect web Inventory page exactly the same Inventory access (admin / manager / staff / viewer, branches) that a person already has in the Flutter app — without changing any existing credentials, existing tables, or the Flutter API routes.

---

## 1. Why the web page fails today

| What happens | Where |
|---|---|
| The web page sends a KelinConnect session token to `/api/flutter-kelinconnect-inventory/*`. | KelinConnect web → KGS-PURCHASE |
| The token is a JWT that only contains `{ userId }` (no employee id). | `kelin-connect-nextjs/src/lib/auth.ts` `generateToken` |
| KGS-PURCHASE cannot read the employee id from the token, so it asks KelinConnect (`KC_ORIGIN`, production `http://190.92.233.232`) whether the token is valid and who it belongs to. | `_lib/auth.js` `kelinConnectAccepts` |
| A token issued by a **local** KelinConnect (`http://localhost/...`) is unknown to production KelinConnect (different `JWT_SECRET` and/or `sessions` row), so it is rejected → **"Your KelinConnect session has expired. Please sign in again."** | `_lib/auth.js` `requireInventoryUser` |
| Even when the token passes, the employee id must come back from a remote lookup; if it doesn't, the API answers 403 "could not match your KelinConnect account to your employee ID". | `_lib/auth.js` |
| The role itself is **not** the problem: roles live in `db_kc_inventory.inv_users`, keyed by employee id (`login_id`, e.g. `KG0751`). Whoever reaches the API as `KG0751` is admin, from any app. | `_lib/members.js` `loadMember` |

**Conclusion:** the web side needs a reliable way to tell the Inventory API "this request is for employee `KG0751`". Once the identity is the same employee id, the same `inv_users` row (same role, same branches) applies automatically. No role copying is needed.

> Do **not** create separate web identities such as `WEB.<username>`. They become new `inv_users` rows with their own role, so a person set as admin in Flutter would not be admin on the web.

---

## 2. Approach: signed server-to-server bridge

```
Browser ──(cookie session)──► KelinConnect web server ──(signed request: employee id)──► KGS-PURCHASE bridge route ──► same _lib functions ──► db_kc_inventory
```

1. The browser only calls the KelinConnect web server (same origin). It never sees any Inventory secret.
2. The KelinConnect web server already knows the signed-in user from its own `session_token` cookie (`getCurrentUser()` → `users.employee_id`).
3. It forwards the call to a **new** KGS-PURCHASE route and signs it with a shared secret (HMAC-SHA256), naming the employee id.
4. KGS-PURCHASE verifies the signature, then loads the member from `inv_users` by that employee id, the same row the Flutter app uses, and calls the existing `_lib` business functions.

What does not change:

- `app/api/flutter-kelinconnect-inventory/**`: not edited. Flutter keeps working as it does now.
- Existing tables and credentials (`users`, `sessions`, `inv_users`, `inv_user_branches`, KGS local accounts): no schema or data change.
- The `KC_INVENTORY_ALLOWED_LOGIN_IDS` pilot list and the `KC_INVENTORY_ADMIN_LOGIN_IDS` bootstrap admins still apply, because the bridge reuses `allowedLoginIds()` and `adminLoginIds()`.

---

## 3. New tables (only additions, `db_kc_inventory`, `inv_` prefix)

Create as `migrations/0xx_inv_web_bridge.sql`.

```sql
-- Apps allowed to call the bridge. The secret itself lives in server env vars;
-- this table lets an admin turn a client off or restrict it without a deploy.
CREATE TABLE IF NOT EXISTS inv_web_clients (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id        VARCHAR(40)  NOT NULL,              -- e.g. 'kc-web'
  name             VARCHAR(120) NOT NULL,
  status           ENUM('active','disabled') NOT NULL DEFAULT 'active',
  secret_sha256    CHAR(64)     NOT NULL,              -- SHA-256 of the env secret (fingerprint only)
  allowed_ips      VARCHAR(500) NULL,                  -- comma list; NULL = any
  identity_mode    ENUM('employee_id','linked') NOT NULL DEFAULT 'employee_id',
  created_by       VARCHAR(50)  NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at     DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_web_clients_client (client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only for apps whose accounts are NOT employee ids (e.g. KGS-PURCHASE local accounts):
-- an Inventory admin links the app account to the employee id.
CREATE TABLE IF NOT EXISTS inv_web_identity_links (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id        VARCHAR(40)  NOT NULL,
  external_user    VARCHAR(100) NOT NULL,              -- app username, upper-cased
  login_id         VARCHAR(50)  NOT NULL,              -- employee id, e.g. KG0751 (= inv_users.login_id)
  status           ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_by       VARCHAR(50)  NOT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_web_links (client_id, external_user),
  KEY ix_inv_web_links_login (login_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

KelinConnect web accounts already carry `employee_id`, so `kc-web` uses `identity_mode = 'employee_id'` and needs no links. `inv_web_identity_links` is only needed if another app (for example the KGS-PURCHASE web page with local usernames) is bridged later.

Seed the client once (the hash is of the secret you put in the env vars below):

```sql
INSERT INTO inv_web_clients (client_id, name, secret_sha256, allowed_ips, created_by)
VALUES ('kc-web', 'KelinConnect web', SHA2('<the secret>', 256), '127.0.0.1,190.92.233.232', 'KG0751');
```

---

## 4. Request signing (both sides must match exactly)

Headers the KelinConnect server sends:

| Header | Value |
|---|---|
| `X-Inv-Client` | `kc-web` |
| `X-Inv-Employee` | employee id from `users.employee_id`, upper-cased (`KG0751`) |
| `X-Inv-Name` | full name (display only, max 120 chars) |
| `X-Inv-Timestamp` | Unix seconds |
| `X-Inv-Nonce` | 16+ random bytes, hex |
| `X-Inv-Signature` | hex HMAC-SHA256 of the canonical string below |

Canonical string (joined with `\n`):

```
METHOD
/path/after/bridge?sorted=query
TIMESTAMP
NONCE
CLIENT_ID
EMPLOYEE_ID
SHA256_HEX_OF_RAW_BODY   (empty body → sha256 of "")
```

Verification rules on KGS-PURCHASE:

1. `X-Inv-Client` exists in `inv_web_clients` with `status = 'active'`, and `SHA2(env secret)` equals `secret_sha256`. Otherwise answer 401 "Inventory bridge not configured".
2. If `allowed_ips` is set, the caller IP must be in it.
3. `|now - timestamp| <= 60` seconds.
4. The nonce has not been seen in the last 120 seconds (in-memory `Map`, cleared when over 5,000 entries).
5. Compare signatures with `crypto.timingSafeEqual`.
6. Employee id matches `/^[A-Z0-9_-]{2,32}$/`. For `identity_mode = 'linked'`, map `X-Inv-Employee` (the app username) through `inv_web_identity_links`.
7. `allowedLoginIds()` from `_lib/auth.js` must allow the employee id. Otherwise answer 403 "Inventory is not open to your account yet." (same text as Flutter).
8. Update `inv_web_clients.last_used_at` at most once a minute.

Secret rotation: accept `INV_WEB_BRIDGE_SECRET` or `INV_WEB_BRIDGE_SECRET_NEXT` during a change-over (store the new fingerprint, switch the sender, then drop the old one).

---

## 5. KGS-PURCHASE side (receiver)

New files only:

```
app/api/kc-web-inventory/_lib/bridge-auth.js   # signature checks (section 4)
app/api/kc-web-inventory/_lib/bridge-member.js # member loader (below)
app/api/kc-web-inventory/[[...path]]/route.js  # GET/POST/PUT dispatcher
migrations/0xx_inv_web_bridge.sql
```

### 5.1 Member loader: the same row as Flutter

`loadMember` in `_lib/members.js` is not exported, so copy its logic into `bridge-member.js`:

- `INSERT ... ON DUPLICATE KEY UPDATE` into `inv_users` by `login_id = employee id`. New people start as `viewer`. `role = IF(bootstrapAdmin, 'admin', role)` keeps admins from `KC_INVENTORY_ADMIN_LOGIN_IDS`.
- Read `inv_user_branches` and build the same member object: `{ id, loginId, name, role, status, allBranches, branchIds:Set, branchCodes, ledger:true }`.
- On the first insert, write the `auth.first_login` audit row with `details: { source: 'kc-web' }`.
- If `status !== 'active'`, answer 403 "Your Inventory access is turned off. Ask an Inventory admin."

Because the key is the employee id, **KG0751 set as admin in the Flutter app is admin on the web immediately**. Role and branch changes made in either app show up in both.

### 5.2 Dispatcher

Map paths to the same `_lib` functions the Flutter routes use (`stock.js`, `movements.js`, `transfers.js`, `adjustments.js`, `counts.js` / `ledger-counts.js`, `alerts.js`, `cases.js`, `insights.js`, `audit.js`, `admin.js`, `members.js` asserts). Use the same paths, query names, bodies and response shapes as `/api/flutter-kelinconnect-inventory/*`. The web module in `F:\jp\workspace-inventory` already calls every root in its `INVENTORY_PROXY_ROOTS`: `health, me, summary, branches, categories, activity, items, watchlist, scan, stock, movements, reason-codes, transfers, adjustments, counts, alerts, cases, audit-logs, erp-compare, reports, admin`. The bridge must answer all of them. The simplest way is to copy each Flutter `route.js` handler body, replacing only the `requireMember(request)` / `optionalMember(request)` call with the bridge member loader. Keep the response shape `{ success, data }` / `{ success:false, message }`, and send `Cache-Control: no-store`. Do not send CORS headers: only the KelinConnect server calls this route.

Before `createTransfer`, keep the "no schema change" guard: if `inv_transfers.reference_no` is missing, set `globalThis.__kcInventoryTransferRef = { until: Date.now() + 10 * 60_000 }` so the library does not run `ALTER TABLE`.

### 5.3 Let the route through the KGS proxy

`proxy.js` sends every non-public path to sign-in when there is no `acu_session` cookie. Add `/api/kc-web-inventory` to `PUBLIC_PATHS`. The HMAC check is that route's authentication.

### 5.4 Env (KGS-PURCHASE `.env`)

```
INV_WEB_BRIDGE_SECRET=<64+ random chars>
# INV_WEB_BRIDGE_SECRET_NEXT=<only during rotation>
```

---

## 6. KelinConnect web side (sender): `F:\jp\workspace-inventory`

The web module already exists (still uncommitted on `master`):

| File | Today |
|---|---|
| `src/app/(dashboard)/dashboard/inventory/**` | Web Inventory pages |
| `src/app/api/kc-inventory/[...path]/route.ts` | Pass-through proxy. It reads the `session_token` cookie and forwards it as `Authorization: Bearer <token>` to `KC_INVENTORY_API_BASE` (`.../api/flutter-kelinconnect-inventory`). **This forwarded token is what fails.** |
| `src/lib/kc-inventory/proxy.ts` | `inventoryApiBase()` (rejects localhost URLs), `buildInventoryUpstreamUrl()` |
| `src/lib/kc-inventory/constants.ts` | `INVENTORY_API_PATH = '/api/kc-inventory'`, `INVENTORY_PROXY_ROOTS` |

The pages and `src/lib/kc-inventory/api.ts` keep calling `/api/kc-inventory/...`, so **no page changes are needed**. Only the proxy changes how it authenticates upstream.

### 6.1 New file: signing helper

```ts
// src/lib/kc-inventory/bridge-sign.ts
import crypto from 'node:crypto'

export const BRIDGE_CLIENT_ID = process.env.KC_INVENTORY_BRIDGE_CLIENT_ID || 'kc-web'

/** Headers proving to KGS-PURCHASE that this server vouches for `employeeId`. */
export function bridgeHeaders(o: {
  method: string; pathWithQuery: string; body: string; employeeId: string; name: string
}): Record<string, string> {
  const secret = process.env.INV_WEB_BRIDGE_SECRET
  if (!secret) throw new Error('INV_WEB_BRIDGE_SECRET is not set')
  const ts = Math.floor(Date.now() / 1000).toString()
  const nonce = crypto.randomBytes(16).toString('hex')
  const bodyHash = crypto.createHash('sha256').update(o.body).digest('hex')
  const canonical = [o.method.toUpperCase(), o.pathWithQuery, ts, nonce, BRIDGE_CLIENT_ID, o.employeeId, bodyHash].join('\n')
  return {
    'X-Inv-Client': BRIDGE_CLIENT_ID,
    'X-Inv-Employee': o.employeeId,
    'X-Inv-Name': o.name.slice(0, 120),
    'X-Inv-Timestamp': ts,
    'X-Inv-Nonce': nonce,
    'X-Inv-Signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex'),
  }
}

/** `/path?a=1&b=2` with query keys sorted, the same canonical form the receiver rebuilds. */
export function canonicalPath(path: string[], search: URLSearchParams): string {
  const p = '/' + path.map(encodeURIComponent).join('/')
  const sorted = new URLSearchParams([...search.entries()].sort(([a], [b]) => a.localeCompare(b))).toString()
  return sorted ? `${p}?${sorted}` : p
}
```

### 6.2 Change in the existing proxy route

In `src/app/api/kc-inventory/[...path]/route.ts`, replace the "token → Bearer" part with "signed-in user → signed employee id". The path allow-list, body forwarding, `Content-Disposition` pass-through (report exports) and error handling stay as they are.

```ts
import { getCurrentUser } from '@/lib/server/get-current-user'
import { bridgeHeaders, canonicalPath } from '@/lib/kc-inventory/bridge-sign'

// inside proxy(), instead of reading the cookie and setting Authorization:
const user = await getCurrentUser()                       // verifies session_token against this app's sessions table
if (!user) return jsonError(401, 'Please sign in again.')
const employeeId = String(user.employee_id || '').trim().toUpperCase()
if (!employeeId) return jsonError(403, 'Your account has no employee ID. Ask HR to add it.')

const base = inventoryBridgeBase()                        // KC_INVENTORY_BRIDGE_BASE, see 6.3
if (!base) return jsonError(502, 'Inventory server is not reachable.')

const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
const body = hasBody ? await req.text() : ''
const pathWithQuery = canonicalPath(path, req.nextUrl.searchParams)

const headers = new Headers(bridgeHeaders({
  method: req.method, pathWithQuery, body, employeeId, name: user.full_name || employeeId,
}))
const contentType = req.headers.get('content-type')
if (contentType && hasBody) headers.set('Content-Type', contentType)

const upstream = await fetch(`${base}${pathWithQuery}`, {
  method: req.method, headers, body: body || undefined, cache: 'no-store', signal: AbortSignal.timeout(30000),
})
```

Note the URL is built from the **same** `pathWithQuery` that was signed (sorted query). Otherwise the receiver's signature check fails.

### 6.3 Base URL

Add to `src/lib/kc-inventory/proxy.ts`:

```ts
/** Signed bridge on KGS-PURCHASE. Loopback is allowed here: both apps run on the same server in production. */
export function inventoryBridgeBase(): string {
  return (process.env.KC_INVENTORY_BRIDGE_BASE || '').trim().replace(/\/$/, '')
}
```

Keep `inventoryApiBase()` / `KC_INVENTORY_API_BASE` for reference or remove its use. The proxy no longer sends the session token anywhere outside this app.

### 6.4 Env (`F:\jp\workspace-inventory\.env` and `.env.example`)

```
KC_INVENTORY_BRIDGE_BASE=http://127.0.0.1/kgs-purchase/api/kc-web-inventory   # production: same server, loopback
KC_INVENTORY_BRIDGE_CLIENT_ID=kc-web
INV_WEB_BRIDGE_SECRET=<same value as KGS-PURCHASE>
```

For local development, either point `KC_INVENTORY_BRIDGE_BASE` at a local KGS-PURCHASE (`http://localhost:3002/api/kc-web-inventory`, with the same secret in both local `.env` files), or at production `http://190.92.233.232/kgs-purchase/api/kc-web-inventory` with the production secret. The second option works from localhost because the employee id now comes from your **local** sign-in, not from a token production must recognise. Only use it on a trusted machine, and never commit the secret.

### 6.5 Update the module guide

`docs/KELINCONNECT-WORKSPACE-INVENTORY.md` §0 and §2.1 say "never add endpoints" and "forward the session token". Update them: the web module talks to the signed bridge (`/api/kc-web-inventory`). The Flutter API (`/api/flutter-kelinconnect-inventory`) stays unchanged and is used only by the Flutter app.

---

## 7. Rollout

1. KGS-PURCHASE: add the migration, the bridge route, and the proxy allow-entry. Set `INV_WEB_BRIDGE_SECRET`. Seed `inv_web_clients`.
2. `F:\jp\workspace-inventory`: add `bridge-sign.ts`, change the `kc-inventory` proxy route (section 6.2), and set the env vars.
3. Sign in to KelinConnect web as KG0751. `GET /api/kc-inventory/me` should return `role: "admin"` and `permissions.canAdmin: true`.
4. Sign in as a non-pilot employee. Expect 403 "Inventory is not open to your account yet."
5. Change a user's role in the Flutter app's Admin screen, then reload the web page. The new role appears on both.

## 8. Tests to add

- KGS: `tests/kc-web-bridge.test.js` (`node --test`). Cover: valid signature, wrong secret, old timestamp, reused nonce, body tampering, disabled client, IP not allowed, employee not in pilot list, linked identity mapping.
- `F:\jp\workspace-inventory`: add to `src/tests/lib/kc-inventory/proxy.test.ts`. Cover the canonical path (sorted query), the signature with a fixed timestamp and nonce, 401 with no session, and 403 with no employee ID.

## 9. Security notes

- The secret stays on the two servers only. It is never sent to the browser or logged.
- The employee id comes from the KelinConnect server's own session check, never from browser input.
- Every write is still checked by the shared `_lib` rules (`assertOperate`, `assertApprove`, `assertAdmin`, `assertNotOwnRequest`) and audited in `inv_audit_logs` with `source: 'kc-web'`.
- The servers talk over loopback when both run on 190.92.233.232. If they ever run on different hosts, use HTTPS or a private network, and keep `allowed_ips` set.
