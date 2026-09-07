# Setup — Dynamic Workflow Intelligence Platform

If you are joining this project on a new machine, follow this exactly. It takes
about 5 minutes. Every step here has bitten someone already.

## Before you start: which branch?

```bash
git clone <repo-url>
cd dynamic-workflow-intelligence
git checkout main
```

**Clone `main`, not `refactor/workflow-intelligence-v2`.** The refactor branch is
being actively rewritten by an autonomous agent and will be broken at random
moments. `main` is the stable, demoable version.

## Prerequisites

| Tool | Version | Check | Notes |
|---|---|---|---|
| Python | **3.11 or 3.12** | `python --version` | 3.13+ can fail to find prebuilt wheels. 3.10 and below will not work — the code uses `X \| Y` type syntax. |
| Node.js | **20 or newer** | `node --version` | Next.js 16 requires it. Node 18 fails. |
| Git | any | `git --version` | |

You do **not** need PostgreSQL, Docker, or a database server. The app uses a
local SQLite file that creates itself.

---

## Option A — one command (recommended)

**Windows (PowerShell), from the repo root:**
```powershell
.\scripts\setup.ps1
```

**macOS / Linux / WSL, from the repo root:**
```bash
bash scripts/setup.sh
```

Then skip to "Running it".

---

## Option B — manual, if the script fails

### 1. Backend

From the **repo root** (not from `backend/`):

**Windows:**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r backend\requirements.txt
```

**macOS / Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r backend/requirements.txt
```

> Install `backend/requirements.txt`, **not** the `requirements.txt` in the repo
> root. The root one only covers the standalone prototype and is missing most of
> the app's dependencies. Installing it instead of the backend file is the single
> most common setup mistake here.

### 2. Frontend

```bash
cd frontend
npm install
cd ..
```

### 3. Do NOT create a `.env` file

`.env.example` contains a **PostgreSQL** connection string. If you copy it to
`.env`, the app will try to reach a Postgres server that does not exist and
crash on startup. The defaults in the code already point at SQLite. Leave `.env`
alone unless you deliberately want Postgres.

---

## Running it

You need **two terminals**, both starting from the repo root.

### Terminal 1 — backend (must be port 8001)

**Windows:**
```powershell
.\scripts\run-backend.ps1
```
**macOS / Linux:**
```bash
bash scripts/run-backend.sh
```

Or manually — note both details, they matter:
```bash
# from the REPO ROOT, on PORT 8001
uvicorn backend.app.main:app --reload --port 8001
```

**Why the repo root?** `backend/app/services/intelligence.py` does
`import engine as E`, which resolves to `engine.py` at the repo root. Running
`cd backend && uvicorn app.main:app` gives you
`ModuleNotFoundError: No module named 'engine'`.

**Why port 8001?** The frontend hardcodes `http://localhost:8001` as its
fallback API URL in both `next.config.ts` and `src/lib/api.ts`. Start the
backend on the default 8000 and the UI loads but shows no data.

Confirm it works: open <http://localhost:8001/health> — you should see
`{"status":"healthy"}`. On first start it creates `dwi.db` and seeds the demo
project automatically.

### Terminal 2 — frontend

```bash
cd frontend
npm run dev
```

Open <http://localhost:3000>.

---

## Troubleshooting — exact errors and their fixes

| What you see | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: No module named 'aiosqlite'` | Missing dependency (was absent from requirements until now) | `pip install aiosqlite`, or re-run `pip install -r backend/requirements.txt` |
| `ModuleNotFoundError: No module named 'engine'` | Ran uvicorn from inside `backend/` | Run from the repo root |
| `ModuleNotFoundError: No module named 'backend'` | Same | Run from the repo root |
| `ModuleNotFoundError: No module named 'sqlalchemy'` / `pydantic_settings` | Installed the root `requirements.txt` | `pip install -r backend/requirements.txt` |
| UI loads but every panel is empty; browser console shows `ERR_CONNECTION_REFUSED` on `:8001` | Backend not running, or running on port 8000 | Restart backend with `--port 8001` |
| `sqlalchemy.exc.InvalidRequestError` / asyncpg or Postgres connection errors | You created a `.env` from `.env.example` | Delete `.env` |
| `error: Microsoft Visual C++ 14.0 or greater is required` during pip install | Trying to compile `psycopg2-binary` / `asyncpg` | Already commented out of requirements. Pull latest, recreate the venv. |
| `TypeError: unsupported operand type(s) for \|` | Python 3.9 or older | Install Python 3.11 or 3.12 |
| `You are using Node.js 18... Next.js requires Node.js >= 20` | Old Node | Install Node 20+ |
| `Activate.ps1 cannot be loaded because running scripts is disabled` | PowerShell execution policy | `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` then activate again |
| Port 8001 or 3000 already in use | Old process still running | Windows: `netstat -ano \| findstr :8001` then `taskkill /PID <pid> /F`. Unix: `lsof -ti:8001 \| xargs kill` |

## Starting over from scratch

Deleting these is always safe — everything regenerates:

```bash
# Windows PowerShell
Remove-Item -Recurse -Force .venv, dwi.db, frontend\node_modules, frontend\.next -ErrorAction SilentlyContinue
# Unix
rm -rf .venv dwi.db frontend/node_modules frontend/.next
```

Then re-run the setup script.

## Running the tests

From the repo root, with the venv active:
```bash
pytest backend/tests -v
```

## Note for whoever updates this later

After the `refactor/workflow-intelligence-v2` branch merges, the run commands
will change (the engine moves into `backend/app/core/`, and the port and entry
point may change). Update this file in the same commit as the merge.
