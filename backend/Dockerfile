# Backend image.
#
# Python is pinned to 3.12 here on purpose: the local venv happens to be 3.14,
# and the image must not depend on that. The application code targets 3.11+.
FROM python:3.12-slim

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# The engine used to live at the repo root as engine.py. Phase 1 moved it into
# backend/app/core/engine/, so copying backend/ is now sufficient - there is no
# longer anything the application needs from the repo root.
COPY backend/ /app/backend/

ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# SQLite lives on a volume so a container restart does not lose the database.
# Override DATABASE_URL to point at Postgres instead; nothing else changes.
ENV DATABASE_URL=sqlite+aiosqlite:////data/dwi.db \
    DATABASE_URL_SYNC=sqlite:////data/dwi.db
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8000

# Bind 0.0.0.0 and read $PORT, so a PaaS can inject the port it wants. `sh -c`
# is required for the variable to be expanded at run time rather than baked in.
CMD ["sh", "-c", "exec uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
