#!/usr/bin/env bash
# Setup script — run from the repo root:  bash scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
echo "Repo root: $ROOT"

PY="${PYTHON:-python3}"
PYV="$($PY -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
echo "Found Python $PYV"
case "$PYV" in
  3.9|3.10|3.8|2.*) echo "ERROR: Python 3.11+ required (the code uses 'X | Y' type syntax)."; exit 1;;
  3.13|3.14|3.15)   echo "WARNING: Python $PYV may lack prebuilt wheels. 3.11 or 3.12 is safest.";;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found. Install Node 20 or newer."; exit 1
fi
NODEV="$(node --version | sed 's/^v//; s/\..*//')"
echo "Found Node v$NODEV"
[ "$NODEV" -lt 20 ] && { echo "ERROR: Node 20+ required for Next.js 16."; exit 1; }

if [ -f .env ]; then
  echo "WARNING: a .env file exists. If it came from .env.example it points at PostgreSQL and the app will crash. Delete it unless you meant it."
fi

echo
echo "Creating virtual environment..."
[ -d .venv ] || "$PY" -m venv .venv
./.venv/bin/python -m pip install --upgrade pip --quiet
echo "Installing backend dependencies (this takes a minute)..."
./.venv/bin/python -m pip install -r backend/requirements.txt --quiet
echo "Backend dependencies installed."

echo
echo "Installing frontend dependencies (this takes a few minutes)..."
(cd frontend && npm install --silent)
echo "Frontend dependencies installed."

cat <<'MSG'

Setup complete. Now open TWO terminals, both at the repo root:

  Terminal 1:  bash scripts/run-backend.sh
  Terminal 2:  cd frontend && npm run dev

Then open http://localhost:3000
Backend health check: http://localhost:8001/health
MSG
