# R&D Management API

Self-contained backend for the R&D Task Management app.

**Public base (production):**  
`http://190.92.233.232/kgs-purchase/api/rd-management/`

**Database:** `db_rd_management` only (never writes to `db_purchase` / `db_kelin_inventory`).

## Bootstrap

On the server (where MySQL is reachable):

```bash
npm run rd:bootstrap
```

Or apply `migrations/rd_management_init.sql`, then hit `GET .../health` once so the API seeds the admin.

Env (already documented in `.env.example`):

- `MYSQL_RD_DATABASE=db_rd_management`
- `RD_ADMIN_EMAIL` / `RD_ADMIN_PASSWORD` / `RD_ADMIN_NAME`

## Auth

```http
POST /api/rd-management/auth_login
Content-Type: application/json

{ "email": "johnpaulpolendey22@gmail.com", "password": "…" }
```

Then send `Authorization: Bearer <token>` (or `X-RD-Session: <token>`).

## Actions

| Action | Method | Notes |
|---|---|---|
| `health` | GET/POST | public |
| `auth_login` | POST | public |
| `auth_logout` | POST | session |
| `auth_me` | GET/POST | session |
| `users_list` / `users_get` / `users_create` / `users_update` | GET/POST | create = admin |
| `tasks_list` / `tasks_get` / `tasks_create` / `tasks_update` / `tasks_claim` / `tasks_status` | GET/POST | |
| `tags_list` / `tags_upsert` | GET/POST | upsert = admin |
| `comments_list` / `comments_add` | GET/POST | |
| `activity_list` | GET/POST | |
| `notifications_list` / `notifications_read` | GET/POST | |
| `metrics_summary` | GET/POST | |
| `search` | GET/POST | `?q=` |

Local example:

`http://localhost:3002/kgs-purchase/api/rd-management/health`  
(if `NEXT_PUBLIC_BASE_PATH=/kgs-purchase`; otherwise `/api/rd-management/health`)
