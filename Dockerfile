# --- SPA build stage ---
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

# --- runtime ---
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY --from=web /web/dist ./app/static

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=5s \
  CMD sh -c 'if [ "$PALIMORA_ROLE" = "worker" ]; then exit 0; fi; curl -sf http://localhost:8000/api/health || exit 1'

# PALIMORA_ROLE selects api (default) or worker — Coolify ignores per-app
# Start Commands for Dockerfile builds, so the role is env-driven.
CMD ["sh", "-c", "if [ \"$PALIMORA_ROLE\" = \"worker\" ]; then exec python -m app.worker; else exec uvicorn app.main:app --host 0.0.0.0 --port 8000; fi"]
