# Dynamic Workflow Intelligence Platform

**We don't just track work. We understand how work changes.**

A deterministic workflow intelligence platform that answers the questions project managers actually ask:

- **Why are we late?** — Root cause analysis with evidence, not guesswork
- **What if a task slips?** — Simulate delays and see downstream impact instantly
- **What if a requirement changes?** — Identify which finished work is now invalid
- **What should I do first?** — Ranked actions by impact score

## Quick Start

### Prerequisites
- Python 3.12+
- Node.js 20+

### 1. Backend

```bash
# Create and activate virtual environment
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# Install dependencies
pip install -r backend/requirements.txt

# Start the API server (auto-creates SQLite DB and seeds demo data)
uvicorn backend.app.main:app --port 8001 --reload
```

The API is now running at http://localhost:8001 with demo data loaded.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000 — the dashboard loads automatically.

### 3. Verify (optional)

```bash
# Run engine regression tests (23 tests)
python -m pytest backend/tests/test_engine.py -v

# Run API integration tests (12 tests)
python -m pytest backend/tests/test_api.py -v

# Run all tests
python -m pytest backend/tests/ -v

# Run the original CLI demo
python demo.py
```

### Docker Compose (PostgreSQL)

```bash
docker compose up
```

This starts PostgreSQL, the API server, and the frontend. Set environment variables in `.env` (see `.env.example`).

## Architecture

```
Frontend (Next.js + React + TypeScript + Tailwind + React Flow)
    |
    | REST API
    v
Backend (FastAPI + SQLAlchemy)
    |
    v
Intelligence Engine (engine.py) <-- deterministic, auditable, no ML
    |
    v
Database (PostgreSQL / SQLite)
```

**Key principle:** Database + deterministic engine = source of truth. AI is an interpretation layer only — it explains findings but never modifies state directly.

## What the Engine Computes

| Feature | Description |
|---------|-------------|
| **CPM Schedule** | Forward/backward pass, earliest start/finish, slack, critical path |
| **Bottleneck Detection** | 4 detectors with evidence and root cause attribution |
| **Delay Simulation** | Propagate a task slip, show affected tasks, notify owners |
| **Requirement Staleness** | Separate MUST REDO (consumed wrong artifact) from MUST RECHECK (merely downstream) |
| **Schedule Diff** | Before/after comparison showing moved tasks, consumed slack, critical path changes |
| **Cycle Detection** | Circular dependencies are caught and reported |

### Bottleneck Detectors

1. **Critical Path Blocker** — walks to earliest incomplete zero-slack ancestor
2. **Resource Contention** — department has more ready tasks than capacity
3. **Stalled in Review** — no activity past threshold
4. **Ready but Idle** — unblocked and nobody started it

Impact score = `days_lost x (1 + downstream_tasks)`. A formula, not a model — anyone can recompute it.

## Demo Data

The system ships with a pre-loaded demo scenario: a campus tech symposium with 17 tasks across 5 departments. Three faults are deliberately planted:

- T03 (budget approval) stalled in review for 9 days on the critical path
- MKT department has 2 ready tasks against capacity 1
- T12 (registration site) unblocked for 10 days, never started

The engine detects all three with 100% recall and 100% precision.

## Project Structure

```
engine.py                    # Intelligence engine (DO NOT MODIFY)
scenario.py                  # Original demo data
demo.py                      # CLI proof / regression test
backend/
  app/
    main.py                  # FastAPI application
    api/routers/             # REST endpoints
    core/                    # Config, database
    models/                  # SQLAlchemy models
    schemas/                 # Pydantic schemas
    services/                # Business logic (intelligence, seed)
  tests/                     # pytest (engine + API)
  alembic/                   # Database migrations
frontend/
  src/
    app/                     # Next.js pages
    components/              # React components
    lib/                     # API client, types
docker-compose.yml           # Full stack with PostgreSQL
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects |
| GET | `/api/projects/{id}/state` | Full project intelligence state |
| GET | `/api/projects/{id}/accuracy` | Detector accuracy vs ground truth |
| POST | `/api/projects/{id}/simulate/delay` | Simulate task delay |
| POST | `/api/projects/{id}/simulate/requirement` | Simulate requirement change |
| GET | `/api/projects/{id}/tasks` | List project tasks |
| POST | `/api/seed` | Seed demo data (idempotent) |

## How is this different?

**"How is this not Jira?"**
Jira stores state. We compute delay attribution, root cause, propagation, and requirement invalidation.

**"How is this not process mining / Celonis?"**
Process mining is retrospective — it tells you what the process *did*. We hold a live dependency model and answer what breaks *next* when a date or a spec moves.

## Test Results

```
35 tests passing:
- 23 engine regression tests (schedule, bottlenecks, simulation, staleness, cycles)
- 12 API integration tests (all endpoints, full regression contract)

Engine accuracy: 3/3 planted faults detected, 0 false positives
```
