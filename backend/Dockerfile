FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# engine.py lives at the repo root on this branch and is imported by
# backend/app/services/intelligence.py. If it moves, this line must move with it.
COPY engine.py /app/engine.py
COPY backend/ /app/backend/

EXPOSE 8000

# Hosting platforms inject $PORT. Falling back to 8000 keeps local docker run working.
CMD ["sh", "-c", "uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
