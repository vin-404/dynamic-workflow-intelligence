#!/usr/bin/env bash
# Starts the backend correctly. Run from anywhere:  bash scripts/run-backend.sh
# Two things this gets right that are easy to get wrong by hand:
#   1. cwd MUST be the repo root  (backend/app/services/intelligence.py does `import engine`)
#   2. port MUST be 8001          (the frontend's fallback API URL)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -x ./.venv/bin/python ]; then
  echo "No virtual environment found. Run 'bash scripts/setup.sh' first."; exit 1
fi

echo "Starting backend on http://localhost:8001 (repo root: $ROOT)"
echo "Health check: http://localhost:8001/health"
echo
exec ./.venv/bin/python -m uvicorn backend.app.main:app --reload --port 8001
