# Deploy

Two services and, optionally, a database. Everything the application needs is
read from environment variables, so **no code change is required to deploy** —
the image you run locally is the image you run in production.

| Piece | Where | Why |
|---|---|---|
| Frontend (Next.js) | **Vercel** | It is a Next.js app; Vercel is where that is least work |
| Backend (FastAPI, Docker) | **Render** (or Railway) | It needs a container and a port, and nothing else |
| Database | **SQLite by default**, **Neon** or **Supabase** for Postgres | SQLite needs no service; Postgres is one URL away when data has to survive |

Deploy the backend first — the frontend needs its URL.

---

## Read this before you start

**Free tiers sleep.** A Render free web service spins down after about fifteen
minutes idle and cold-starts in roughly fifty seconds. Fifty seconds of blank
screen in front of a judge is the single most embarrassing failure mode in
this whole plan. Either open the URL a few minutes before you present, or pay
for the smallest paid instance for two days.

**SQLite on a PaaS is ephemeral.** Render's disk does not survive a deploy or
a wake-from-sleep, so the database starts empty and re-seeds itself. That is
fine for a demo and wrong the moment a judge creates a project and comes back
to it. Step 3 fixes it.

---

## Step 1 — Backend on Render

1. [render.com](https://render.com) → sign in with GitHub → **New → Web Service**
2. Connect this repository.
3. Settings:

   | Field | Value |
   |---|---|
   | Language / Runtime | **Docker** |
   | Dockerfile Path | `backend/Dockerfile` |
   | Docker Build Context Directory | `.` — the repo root, because the Dockerfile copies `backend/` from there |
   | Branch | `main` |
   | Health Check Path | `/health` |
   | Instance Type | Free to start; see the warning above |

4. Environment variables — see the full table at the bottom. The minimum:

   | Key | Value |
   |---|---|
   | `CORS_ORIGINS` | `http://localhost:3000` for now; add the Vercel URL after step 2 |
   | `ADMIN_TOKEN` | a long random string, if you want the reset button |
   | `PROXY_SHARED_SECRET` | a long random string — **the same one you set on Vercel** |

   Leave `DATABASE_URL` unset for SQLite. Leave `PORT` unset — Render injects
   it and the image reads it.

5. Deploy, then check:

   ```bash
   curl https://<your-service>.onrender.com/health   # {"status":"healthy"}
   curl https://<your-service>.onrender.com/ready    # {"status":"ready",...}
   ```

   `/health` says the process is up. `/ready` says the database answers.
   **If `/health` passes and `/ready` fails, your `DATABASE_URL` is wrong** —
   that is exactly the distinction those two endpoints exist to draw.

   If the build fails, read the log. A missing package means
   `backend/requirements.txt` is out of date, not that the platform is broken.

**Copy the backend URL. You need it next.**

---

## Step 2 — Frontend on Vercel

1. [vercel.com](https://vercel.com) → sign in with GitHub → **Add New → Project**
2. Import this repository.
3. Settings:

   | Field | Value |
   |---|---|
   | Root Directory | **`frontend`** — this one matters; the repo root is not a Next.js app and the build fails without it |
   | Framework Preset | Next.js (auto-detected) |
   | Build and output | leave default |

4. Environment variables:

   | Key | Value |
   |---|---|
   | `API_REWRITE_URL` | `https://<your-service>.onrender.com` |
   | `AUTH_GOOGLE_ID` | from the Google Cloud Console |
   | `AUTH_GOOGLE_SECRET` | from the Google Cloud Console |
   | `AUTH_SECRET` | `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
   | `NEXTAUTH_URL` | `https://<your-app>.vercel.app` |
   | `PROXY_SHARED_SECRET` | the same value you set on Render |

   **There is no `NEXT_PUBLIC_API_URL`, and adding one back would break the
   security model.** The browser talks only to the Vercel origin, because that
   is where `src/proxy.ts` verifies the Google session and injects the identity
   headers the backend trusts. An absolute backend URL in the browser bundle
   would send requests straight to Render, past the session check and past the
   injection — the app would look signed-in while every request arrived
   anonymous. `src/lib/api.ts` hard-codes a relative base and reads no
   variable, so there is nothing to get wrong here.

   `API_REWRITE_URL` is read at **runtime** by the Node.js proxy, so changing
   it takes effect on a restart. It is not inlined into the bundle.

   In the Google Cloud Console, register the redirect URI as
   `https://<your-app>.vercel.app/api/auth/callback/google`. A mismatch here is
   the single most common sign-in failure and Google's error names it.

5. Deploy, then **go back to Render and add the Vercel URL to `CORS_ORIGINS`**:

   ```
   CORS_ORIGINS=https://<your-project>.vercel.app,http://localhost:3000
   ```

   Comma-separated, no spaces needed, no quotes, no brackets. `*` is refused
   at startup — this API allows credentials, and a wildcard with credentials
   is rejected by every browser anyway.

   Redeploy the backend. Skipping this gives you a page that loads and shows
   no data, with a CORS error in the browser console.

---

## Step 3 — Postgres, when data has to survive

1. [neon.tech](https://neon.tech) or [supabase.com](https://supabase.com) →
   new project → copy the connection string.
2. Convert it to the async form. SQLAlchemy needs the driver named:

   ```
   postgresql://user:pass@host/db          ← what they give you
   postgresql+asyncpg://user:pass@host/db  ← what you set
   ```

   A plain `postgresql://` URL fails at startup with a driver error. `asyncpg`
   is already in `requirements.txt`; nothing needs installing.

3. Set on Render:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | `postgresql+asyncpg://user:pass@host/dbname` |

   Neon requires TLS, which asyncpg does by default. If the host demands an
   explicit mode, append `?ssl=require` — note `ssl`, not `sslmode`, which is
   psycopg's spelling and asyncpg rejects it.

4. Redeploy. Tables are created on startup (`create_all`) and the seed is
   idempotent, so there is no migration step and a restart against a populated
   database writes nothing.

5. Verify: `curl https://<backend>/ready` should report
   `"database": "postgres"`.

---

## First-deploy checklist

Work down it. Each line is a thing that has gone wrong for somebody.

- [ ] `curl https://<backend>/health` → `{"status":"healthy"}`
- [ ] `curl https://<backend>/ready` → `"status":"ready"` and the database you expect
- [ ] `curl https://<backend>/api/projects` → two seeded projects
- [ ] `curl -X POST https://<backend>/api/projects/00000000-0000-0000-0000-000000000001/analyze` → findings
- [ ] Open the Vercel URL. You land on `/login`, not on the app.
- [ ] `curl https://<frontend>/api/projects` → **401** with a `hint`. The API is
      not reachable without a session, even though the backend's own URL is.
- [ ] Sign in with Google. The workflow list appears with both seeded workflows.
- [ ] Open one and click through to **Bottlenecks**. Findings render.
- [ ] Open the browser console. No CORS errors, no red.
- [ ] Reload the page. You are still signed in, on the same workflow.
- [ ] Open the site in a second browser. It asks that one to sign in separately.
- [ ] Sign out. You land back on `/login`, and reloading the app does not let
      you back in.
- [ ] If you set `PROXY_SHARED_SECRET`, confirm the header alone is not enough:
      `curl https://<backend>/api/projects -H "X-User-Id: <a real uuid>"` is
      served as **anonymous**, and a write with that header returns 403. If a
      write succeeds, the secret is not actually set on the backend.
- [ ] If you set `ADMIN_TOKEN`:
      `curl -X POST https://<backend>/admin/reset-seed -H "X-Admin-Token: ..."`
      → `{"status":"reset",...}`

If any line fails, the troubleshooting table below has it.

---

## Verify in thirty seconds, any time

```bash
curl -s https://<backend>/ready
curl -s -X POST https://<backend>/api/projects/00000000-0000-0000-0000-000000000001/analyze | head -c 300
```

Then open the frontend. You will be sent to `/login` — sign in with Google
first; every route except the sign-in page requires a session. If the page
loads signed-in but every panel is empty, it is `API_REWRITE_URL` or a
`PROXY_SHARED_SECRET` mismatch nine times out of ten. Open the browser console
and the network tab: a 401 from `/api/*` is the proxy refusing you, and a 403
is the backend refusing your **role** — the response body names the role you
hold and the one the route needs.

---

## Rollback

- **Render**: Deploys tab → the last good deploy → **Redeploy**
- **Vercel**: Deployments tab → the previous deployment → **Promote to Production**

Both take under a minute. Find these buttons *before* you need them.

If a bad deploy also corrupted the data, `POST /admin/reset-seed` with the
token puts the database back to both seed domains without a redeploy.

---

## Re-pointing the frontend at a new backend

The backend URL is now read at runtime by the Next.js proxy, not compiled into
the bundle, so this is a restart rather than a rebuild:

1. Vercel → the project → **Settings → Environment Variables**
2. Change `API_REWRITE_URL`. There is no browser-side URL to change.
3. Set `PROXY_SHARED_SECRET` on the new backend to the same value the frontend
   already has, or set both to new matching values.
4. Redeploy the frontend so the new environment is picked up.
5. `CORS_ORIGINS` on the new backend matters much less than it used to — the
   browser no longer calls the backend directly — but set it anyway, so a
   direct call from a tool or a future client is not a mystery.

---

## One process, while replay exists

**Run the backend as a single process.** Do not raise the worker count.

`GET /api/projects/{id}/stream` replays a project's event log over Server-Sent
Events, and the replay it streams lives in that process's memory (D-143). A
replay is a viewing position over already-durable data - scratch paper, exactly
as a `Scenario` is - so persisting it would put a write path next to the one
feature whose whole promise is that it writes nothing. The cost of that choice
is this constraint: with more than one worker, `POST /replay` and the
`GET /stream` that follows it can land on different workers, and the second one
reports that no replay is running. Nothing is corrupted and nothing is lost -
the live screen simply never starts.

Render's default is one instance, so the default is already correct. If you add
workers or scale to more than one instance, replay is the feature that breaks
first, and it breaks silently from the user's side. Making it survive needs a
shared broker - Redis pub/sub or Postgres `LISTEN`/`NOTIFY` - which is a real
piece of work and deliberately out of scope.

Every other capability is stateless across requests and scales horizontally
without changes.

A second, smaller consequence of the same design: the role guard resolves a
database session for every request including the SSE one, so an open stream
holds a pooled connection for its lifetime. On SQLite that costs nothing. On
Postgres, size the pool against the number of concurrent viewers you expect,
not the number of requests per second.

---

## Environment variables, complete

### Backend

| Key | Required | Example | Purpose |
|---|---|---|---|
| `CORS_ORIGINS` | **yes** | `https://app.vercel.app,http://localhost:3000` | Exact origins allowed to call the API, comma-separated. `*` is refused. |
| `DATABASE_URL` | no | `postgresql+asyncpg://u:p@host/db` | Defaults to SQLite in the container, which does not survive a deploy. |
| `DATABASE_URL_SYNC` | no | `postgresql://u:p@host/db` | Tooling only. Keep it pointing at the same database. |
| `PORT` | injected | `10000` | Set by the platform; the image reads it. Do not hardcode. |
| `ENVIRONMENT` | no | `production` | Hides exception detail from 500 responses. |
| `ADMIN_TOKEN` | no | a long random string | Guards `POST /admin/reset-seed`. **Empty disables the endpoint.** |
| `PROXY_SHARED_SECRET` | recommended | 32+ random bytes | Backend half of the identity handshake. `X-User-Id` is honoured only when `X-Proxy-Secret` matches, and `ProjectMember.role` becomes enforced. **Empty keeps the pre-auth open behaviour**, which is what a fresh clone and the test suite run. Must equal the frontend's. Setting it without `ADMIN_TOKEN` also disables `POST /api/seed/reset`. |
| `SEED_ON_STARTUP` | no | `true` | Load both demo domains at boot. Idempotent. |
| `GITHUB_WEBHOOK_SECRET` | no | 32+ random bytes | Secret GitHub signs each delivery with. `POST /api/ingest/github` recomputes HMAC-SHA256 over the raw body and compares it in constant time. **Empty disables the endpoint** (403) - a webhook has no session, so the signature is the whole of its authentication and there is no unsigned development mode. The webhook URL also carries `?project_id=<uuid>`, which is visible to anyone who can read the repository's webhook settings; the signature, not the id, is what gates the write. |
| `ANALYZE_TIMEOUT_SECONDS` | no | `20` | Ceiling, not a target — analyze takes about 20ms. |
| `SIMULATE_TIMEOUT_SECONDS` | no | `20` | As above. |
| `OPTIMIZE_TIMEOUT_SECONDS` | no | `30` | Backstop; the search has its own budget. |
| `ANTHROPIC_API_KEY` | no | `sk-ant-...` | Absent selects the offline path, under which **every capability still works**. |
| `AI_PROVIDER` | no | `null` | `null` forces the offline path even with a key set. Recommended for a demo. |

### Frontend

| Key | Required | Example | Purpose |
|---|---|---|---|
| `API_REWRITE_URL` | **yes** | `https://api.onrender.com` | Backend URL as the **Next.js server** reaches it. Read at runtime by `src/proxy.ts` and by the sign-in upsert. |
| `AUTH_GOOGLE_ID` | **yes** | `1234-abc.apps.googleusercontent.com` | Google OAuth client id. |
| `AUTH_GOOGLE_SECRET` | **yes** | `GOCSPX-...` | Google OAuth client secret. |
| `AUTH_SECRET` | **yes** | 32+ random bytes | Signs and encrypts the session cookie. |
| `NEXTAUTH_URL` | **yes** | `https://app.vercel.app` | The origin Auth.js builds callback URLs from. Must match what Google has registered. |
| `PROXY_SHARED_SECRET` | recommended | 32+ random bytes | Frontend half of the identity handshake. Must equal the backend's. Unset on both sides = open mode. |
| `E2E_AUTH_ENABLED` | **never in a deployment** | `1` | Adds a password-free sign-in for the browser walkthroughs. Requires `NODE_ENV != production`, so a `next build` bundle cannot contain it — but do not set it anyway. |
| `NEXT_PUBLIC_API_URL` | **removed** | — | Deliberately no longer read. See the note in the Vercel step above: a browser-side backend URL bypasses the session check entirely. |

No secret belongs in this repository. Everything above is set in the platform
dashboards. `.env.example` documents the same list for local use and contains
no real values.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page loads, every panel empty, console shows a CORS error | The frontend origin is not in `CORS_ORIGINS` | Add it, comma-separated, redeploy the backend |
| Page loads, panels empty, console shows a 404 or `ERR_CONNECTION_REFUSED` on `/api/...` | `API_REWRITE_URL` wrong | Fix it and restart; it is read at runtime, so no rebuild is needed |
| Every `/api/*` call returns 401 while the app looks signed-in | The session carries no backend user id | Sign out and back in. If it persists the backend was unreachable at sign-in; check `/ready` |
| A write returns 403 naming a role | Working as designed — `PROXY_SHARED_SECRET` is set and you are a `viewer`, or not a member | An owner adds you as an `editor` on the project |
| Sign-in returns `?error=AccessDenied` | The backend refused the user upsert at sign-in — usually the backend is down or `PROXY_SHARED_SECRET` does not match | Check `/ready`, then compare the secret on both sides byte for byte |
| Sign-in returns `?error=Configuration` | `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`/`AUTH_SECRET` missing | Set all three and redeploy |
| Google says `redirect_uri_mismatch` | The registered URI is not `<NEXTAUTH_URL>/api/auth/callback/google` | Fix it in the Google Cloud Console; check for a trailing slash |
| The walkthroughs fail at sign-in with a 404 on `/api/auth/callback/e2e` | The app is running a production build, where the provider cannot exist | Run them against `next dev` with `E2E_AUTH_ENABLED=1` |
| `/health` passes, `/ready` returns 503 | The database is unreachable | Check `DATABASE_URL`, and that it starts `postgresql+asyncpg://` |
| Startup crashes with a driver error | `postgresql://` instead of `postgresql+asyncpg://` | Add `+asyncpg` |
| Startup crashes with `CORS_ORIGINS cannot be '*'` | Exactly what it says | List the exact origins |
| Everything works, then the data is gone | SQLite on an ephemeral disk | Step 3 |
| `POST /admin/reset-seed` returns 403 | No `ADMIN_TOKEN` is set, so the endpoint does not exist | Set one and redeploy |
| `POST /admin/reset-seed` returns 401 | Wrong or missing `X-Admin-Token` header | Send the header |
| First request after idle takes ~50s | The free instance was asleep | Pay for the smallest paid tier, or warm it before you present |

---

## Running it locally in containers first

Before any of the above, prove the artifacts work on your machine:

```bash
bash scripts/smoke.sh          # builds the image, starts it, checks it end to end
# or on Windows:
.\scripts\smoke.ps1
```

It builds from scratch, waits for live then ready, resets the seed, analyzes
both domains under a one-second budget, and checks that the refusal still
cites its constraint. To rehearse the Postgres path:

```bash
docker compose --profile postgres up -d db
DATABASE_URL="postgresql+asyncpg://dwi:dwi@host.docker.internal:5433/dwi" bash scripts/smoke.sh
```

If the smoke script fails on your machine, it will fail on Render for the same
reason.
