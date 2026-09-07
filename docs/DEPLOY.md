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
   | `NEXT_PUBLIC_API_URL` | `https://<your-service>.onrender.com` |
   | `API_REWRITE_URL` | `https://<your-service>.onrender.com` |

   **Both.** `src/lib/api.ts` reads the first in the browser;
   `next.config.ts` reads the second for server-side rewrites. Setting only
   one gives you a site that works in some places and not others.

   `NEXT_PUBLIC_*` is inlined **at build time**. Changing it later requires a
   redeploy, not just a restart.

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
- [ ] Open the Vercel URL. It asks who you are.
- [ ] Pick a name. The workflow list appears with both seeded workflows.
- [ ] Open one and click through to **Bottlenecks**. Findings render.
- [ ] Open the browser console. No CORS errors, no red.
- [ ] Reload the page. You are still the same person, on the same workflow.
- [ ] Open the site in a second browser. It asks who you are separately.
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

Then open the frontend and confirm data renders. If the page loads but is
empty, it is CORS or a wrong `NEXT_PUBLIC_API_URL` nine times out of ten —
open the browser console and it will say which.

---

## Rollback

- **Render**: Deploys tab → the last good deploy → **Redeploy**
- **Vercel**: Deployments tab → the previous deployment → **Promote to Production**

Both take under a minute. Find these buttons *before* you need them.

If a bad deploy also corrupted the data, `POST /admin/reset-seed` with the
token puts the database back to both seed domains without a redeploy.

---

## Re-pointing the frontend at a new backend

The backend URL is baked into the frontend at build time, so this is a
redeploy, not a restart:

1. Vercel → the project → **Settings → Environment Variables**
2. Change **both** `NEXT_PUBLIC_API_URL` and `API_REWRITE_URL`.
3. **Deployments → the latest → Redeploy.** Do not skip this: changing the
   variable alone does nothing, because the old build already has the old URL
   compiled into it.
4. Add the frontend origin to `CORS_ORIGINS` on the *new* backend and redeploy
   that too.

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
| `SEED_ON_STARTUP` | no | `true` | Load both demo domains at boot. Idempotent. |
| `ANALYZE_TIMEOUT_SECONDS` | no | `20` | Ceiling, not a target — analyze takes about 20ms. |
| `SIMULATE_TIMEOUT_SECONDS` | no | `20` | As above. |
| `OPTIMIZE_TIMEOUT_SECONDS` | no | `30` | Backstop; the search has its own budget. |
| `ANTHROPIC_API_KEY` | no | `sk-ant-...` | Absent selects the offline path, under which **every capability still works**. |
| `AI_PROVIDER` | no | `null` | `null` forces the offline path even with a key set. Recommended for a demo. |

### Frontend

| Key | Required | Example | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | **yes** | `https://api.onrender.com` | Backend URL as the **browser** reaches it. Inlined at build time. |
| `API_REWRITE_URL` | **yes** | `https://api.onrender.com` | Backend URL as the **Next.js server** reaches it, for rewrites. |

No secret belongs in this repository. Everything above is set in the platform
dashboards. `.env.example` documents the same list for local use and contains
no real values.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page loads, every panel empty, console shows a CORS error | The frontend origin is not in `CORS_ORIGINS` | Add it, comma-separated, redeploy the backend |
| Page loads, panels empty, console shows `ERR_CONNECTION_REFUSED` or a 404 on `/api/...` | `NEXT_PUBLIC_API_URL` wrong or unset at build time | Fix it and **redeploy** — a restart is not enough |
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
