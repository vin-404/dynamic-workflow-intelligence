# Deploy Runbook

Two services and (optionally) a database. Everything the app needs is read
from environment variables, so no code changes are required to deploy.

- **Frontend** — Next.js → Vercel
- **Backend** — FastAPI in Docker → Render (or Railway)
- **Database** — SQLite by default; managed Postgres when you want persistence

Deploy the backend first: the frontend needs its URL.

---

## Read this before you start

**Free tiers sleep.** A Render free web service spins down after ~15 minutes
idle and cold-starts in roughly 50 seconds. Fifty seconds of blank screen in
front of a judge is a disaster. Either open the URL a few minutes before you
present, or pay for the smallest paid instance for the two days — it costs
about the price of a coffee and removes the single most embarrassing failure
mode in this whole plan.

---

## Step 1 — Backend on Render

1. render.com → sign up with GitHub → **New → Web Service**
2. Connect `vin-404/dynamic-workflow-intelligence`
3. Settings:
   - **Language / Runtime**: Docker
   - **Dockerfile Path**: `backend/Dockerfile`
   - **Docker Build Context Directory**: `.` (the repo root — the Dockerfile
     copies `backend/` and `engine.py` from there)
   - **Branch**: `main`
   - **Instance Type**: Free to start
4. Environment variables:

   | Key | Value | Notes |
   |---|---|---|
   | `PYTHONPATH` | `/app` | already set in the image; harmless to repeat |
   | `CORS_ORIGINS` | `["http://localhost:3000"]` | JSON array. Add the Vercel URL after step 2. |
   | `DATABASE_URL` | *(leave unset)* | defaults to SQLite. See step 3 for Postgres. |

5. Deploy. When it's live, check:
   - `https://<your-service>.onrender.com/health` → `{"status":"healthy"}`
   - `https://<your-service>.onrender.com/docs` → the OpenAPI page

   If the build fails, read the log: a missing package means
   `backend/requirements.txt` is out of date, not that the platform is broken.

**Copy the backend URL. You need it next.**

---

## Step 2 — Frontend on Vercel

1. vercel.com → sign up with GitHub → **Add New → Project**
2. Import `vin-404/dynamic-workflow-intelligence`
3. Settings:
   - **Root Directory**: `frontend`  ← this one matters; the repo root is not
     a Next.js app and the build fails without it
   - **Framework Preset**: Next.js (auto-detected)
   - Build and output settings: leave default
4. Environment variables:

   | Key | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://<your-service>.onrender.com` |
   | `API_REWRITE_URL` | `https://<your-service>.onrender.com` |

   Both, because `src/lib/api.ts` reads the first (client-side) and
   `next.config.ts` reads the second (server-side rewrites).

5. Deploy, then **go back to Render and add the Vercel URL to `CORS_ORIGINS`**:

   ```
   ["http://localhost:3000","https://<your-project>.vercel.app"]
   ```

   Redeploy the backend. Skipping this gives you a page that loads and shows
   no data, with a CORS error in the browser console — the exact symptom you
   already debugged once locally.

---

## Step 3 — Postgres, when you want data to survive restarts

SQLite on Render lives on an ephemeral disk: every deploy and every wake-from-
sleep starts from an empty database, which then re-seeds. That is fine for a
demo and not fine if a judge creates a project and comes back to it.

1. neon.tech (or supabase.com) → new project → copy the connection string
2. Re-enable the driver in `backend/requirements.txt`:
   ```
   asyncpg==0.30.0
   ```
3. Set on Render:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | `postgresql+asyncpg://user:pass@host/db` |

   Note the `+asyncpg` — SQLAlchemy needs the async driver named explicitly.
   A plain `postgresql://` URL will fail at startup.
4. Redeploy. Tables are created on startup (`create_all`), so no migration
   step is required.

---

## Verify a deploy in 30 seconds

```bash
curl https://<backend>/health                       # {"status":"healthy"}
curl https://<backend>/api/projects/00000000-0000-0000-0000-000000000001/state | head -c 300
```

Then open the frontend URL and confirm data renders. If the page loads but is
empty, open the browser console — it is CORS or a wrong `NEXT_PUBLIC_API_URL`
nine times out of ten.

---

## Rollback

- **Render**: Deploys tab → pick the last good deploy → Redeploy
- **Vercel**: Deployments tab → the previous deployment → Promote to Production

Both take under a minute. Know where these buttons are *before* you need them.

---

## Environment variables, complete list

| Service | Key | Required | Purpose |
|---|---|---|---|
| Backend | `CORS_ORIGINS` | yes | JSON array of allowed frontend origins |
| Backend | `DATABASE_URL` | no | Postgres async URL; defaults to local SQLite |
| Backend | `PORT` | injected | set by the platform; the image honours it |
| Frontend | `NEXT_PUBLIC_API_URL` | yes | backend base URL, used client-side |
| Frontend | `API_REWRITE_URL` | yes | backend base URL, used by Next rewrites |

No secrets belong in the repo. All of the above are set in the platform
dashboards.
