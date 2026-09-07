# Phase 9 — Production Hardening and Deployment

Append this to `docs/AUTONOMOUS_PROMPT.md` and tell the agent it exists.
It runs after Phase 8.

---

## Paste into the agent's terminal now

````
Two additions to your instructions.

FIRST — do this immediately, before continuing your current phase, because it
is already broken and it is cheap to fix now:

  backend/Dockerfile does `COPY engine.py /app/engine.py`, but phase 1 deleted
  that file. The image cannot build. Fix the Dockerfile to match the current
  layout, make the port configurable (`--port ${PORT:-8000}`, host 0.0.0.0),
  and verify with an actual `docker build`. Do the same check for
  frontend/Dockerfile and docker-compose.yml. Commit as a fix, then resume.

  From now on, whenever you move or delete a file, check whether any
  deployment artifact references it.

SECOND — a new Phase 9 has been added to docs/AUTONOMOUS_PROMPT.md. Read it
and execute it after Phase 8. Same rules as every other phase: verify, report,
commit, tag, no questions.
````

---

## PHASE 9 — PRODUCTION HARDENING AND DEPLOYMENT

The goal is a deployed, shareable, resilient product — not an enterprise
feature set. Judge every item by "would a user notice this in five minutes of
use". If not, do not build it.

### 9.1 — Deployment artifacts must actually work

- Fix `backend/Dockerfile`: correct file layout after the refactor, bind
  `0.0.0.0`, read `--port ${PORT:-8000}` so a PaaS can inject the port. Verify
  with a real `docker build` and a container that answers `/health`.
- Fix `frontend/Dockerfile` and `docker-compose.yml` the same way.
- Pin Python 3.12 in the backend image (the local venv is 3.14; the image must
  not depend on that).
- Add a `.dockerignore` excluding `.venv`, `node_modules`, `dwi.db`,
  `__pycache__`, `.next`, `.git`.
- **Add a CI-less smoke check**: a single script
  (`scripts/smoke.sh` / `.ps1`) that builds, starts, waits for `/health`,
  runs the seed reset, calls `/analyze` on both seed domains, and exits
  non-zero on any failure. This is what gets run before every demo.

### 9.2 — Postgres compatibility without abandoning SQLite

- Everything already reads `DATABASE_URL` from the environment. Keep SQLite as
  the local default; make Postgres work by configuration alone.
- Re-enable `asyncpg` in `backend/requirements.txt` (it is commented out).
  Keep `psycopg2-binary` out unless something genuinely needs sync access.
- `create_all` on startup stays (decision D-03) — it works on Postgres too.
  Do not introduce Alembic migrations now.
- Verify against a real Postgres (docker-compose already defines one) that the
  full test suite and both seed fixtures work unchanged.
- Guard the startup seed so it is idempotent: seeding must not duplicate rows
  when the container restarts against an existing database.

### 9.3 — Configuration and CORS

- `CORS_ORIGINS` must be settable from an environment variable as a
  comma-separated list, and must include the deployed frontend origin. A
  wildcard is not acceptable once credentials are allowed.
- The frontend's `NEXT_PUBLIC_API_URL` must come from the environment with the
  localhost default retained for development.
- Write `.env.example` to describe the deployed shape accurately — it currently
  describes a Postgres setup nobody uses. It should document every variable the
  app reads, with a comment on each.
- No secret, key or connection string is ever committed.

### 9.4 — Resilience a user can actually feel

- **Error boundaries** in the frontend so a thrown component never blanks the
  page. A failed request renders an actionable message and a retry, never a
  stack trace and never an infinite spinner.
- **Empty states** for every list and panel: no project, no tasks, no findings,
  no history. Each says what to do next. A new user's first screen is an empty
  state, so these are first-impression surfaces, not edge cases.
- **Loading states** on every async action. Any action over ~300ms shows
  progress; long operations (optimize) show what stage they are in.
- **Bounded work**: analyze, simulate and optimize all take an explicit
  timeout. Exceeding it returns a structured, explained error rather than
  hanging the request.
- **Structured API errors**: every 4xx/5xx returns `{error, detail, hint}`
  where `hint` tells the user what to do. Validation failures already produce
  human-readable reasons — surface them, do not swallow them.
- **Request logging** with a request id, method, path, status and duration.
  One line per request, structured. No log of request bodies.
- `/health` stays liveness-only. Add `/ready` which verifies the database
  answers a trivial query.

### 9.5 — Multi-user without authentication

Do NOT build login, passwords, sessions, OAuth, SSO or RBAC.

- A name-picker: the user chooses or creates a `User` on first visit, stored
  client-side. That identity is sent on requests and drives ownership and
  assignment.
- `ProjectMember` roles stay owner/editor/viewer and are advisory in the UI.
  Do not build a permission enforcement layer.
- Two browsers must be able to open the same project and both see a change
  after a refresh. Live sync is not required.

### 9.6 — A safe playground for judges

- A `POST /admin/reset-seed` endpoint (guarded by a token from the environment)
  that drops and reloads both seed domains. This is what makes the deployment
  safe to hand to a stranger.
- The demo path must be re-runnable from a cold database in one command.

### 9.7 — Performance floor

- `analyze` on a seed project returns in under one second, warm.
- `optimize` respects its candidate and time budget and returns partial ranked
  results rather than timing out.
- Measure all three endpoints and record the numbers in the phase report. If
  something is slow, profile it — do not add caching to hide it.

### 9.8 — Deployment handoff

The agent cannot create accounts or click through hosting dashboards. Prepare
everything else and write `docs/DEPLOY.md` containing:

- exact steps for the human: what accounts to create, what to click, in order
- the complete list of environment variables for each service, with example
  values, marked required or optional
- a first-deploy checklist and how to verify each service is healthy
- the rollback step if a deploy breaks
- how to re-point the frontend at a new backend URL

Target stack (do not substitute without recording a decision):
Vercel for the Next.js frontend, Render or Railway for the backend container,
Neon or Supabase for managed Postgres.

### 9.9 — Explicitly out of scope

Do not build, and do not suggest: authentication, SSO, OAuth, RBAC or
permission enforcement, multi-tenancy, organisation hierarchies, audit logging
beyond the existing analysis history, rate limiting, quota systems,
CI/CD pipelines, Kubernetes manifests, service meshes, message queues,
caching tiers, monitoring or APM stacks, feature flags, i18n, mobile apps,
or a status page.

If you finish 9.1–9.8 with time remaining, spend it on empty states, error
messages and the smoke script — not on anything in this list.

### Verification before the phase commit

Run the smoke script against a container built from scratch, on Postgres,
from an empty database. Record in `docs/PROGRESS.md`: the smoke output, the
three endpoint timings, and every environment variable required to deploy.
Tag `phase-9-deploy`.
