# syntax=docker/dockerfile:1.7
# ------------------------------------------------------------------------------
# Connection Manager – Backend Image
#
# Equinix-Vorgaben:
#   * Base-Image NUR aus der InfoSec-Registry (appsec.docker.equinix.com),
#     immer mit gepinntem Tag – kein "latest", kein Docker Hub.
#   * Python-Pakete NUR über den Nexus-PyPI-Mirror.
#
# Beide Werte kommen als Build-Args aus docker-compose.yml / Portainer
# (BASE_IMAGE, PIP_INDEX_URL). Den exakten Image-Pfad/Tag bitte in
# appsec.docker.equinix.com nachschlagen und in Portainer als Stack-Variable
# BASE_IMAGE setzen – der Default unten ist nur ein Platzhalter-Beispiel.
# ------------------------------------------------------------------------------
ARG BASE_IMAGE=appsec.docker.equinix.com/infosec/python:3.11-slim

# ---------- Stage 1: Dependencies in ein venv installieren --------------------
FROM ${BASE_IMAGE} AS builder

ARG PIP_INDEX_URL=https://nexus.equinix.com/repository/pypi-mirror/simple/
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /build
COPY requirements.txt .

# Alle Pakete liegen als Binary-Wheels vor (psycopg2-binary, bcrypt, cryptography),
# daher ist kein gcc / apt nötig – das hält das Image klein und funktioniert
# auch auf Base-Images ohne Paketmanager.
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# ---------- Stage 2: Runtime --------------------------------------------------
FROM ${BASE_IMAGE} AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # uvicorn hinter Nginx Proxy Manager: Proxy-Header aller Upstreams akzeptieren
    FORWARDED_ALLOW_IPS="*" \
    WEB_CONCURRENCY=1 \
    UVICORN_LIMIT_CONCURRENCY=200 \
    UVICORN_TIMEOUT_KEEP_ALIVE=15 \
    LOG_LEVEL=info

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv

# Nur das, was zur Laufzeit gebraucht wird (siehe .dockerignore)
COPY --chown=${APP_UID}:${APP_GID} app.py config.py database.py models.py security.py audit.py crud.py ./
COPY --chown=${APP_UID}:${APP_GID} routers/    routers/
COPY --chown=${APP_UID}:${APP_GID} scripts/    scripts/
COPY --chown=${APP_UID}:${APP_GID} migrations/ migrations/
COPY --chown=${APP_UID}:${APP_GID} frontend/   frontend/

# Numerische UID: funktioniert auch, wenn das Base-Image keine useradd/adduser
# Binaries mitbringt. Der Container läuft nie als root.
USER ${APP_UID}:${APP_GID}

EXPOSE 8000

# Liveness ohne Auth und ohne curl-Abhängigkeit
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request;r=urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=4);sys.exit(0 if r.status==200 else 1)"]

# WICHTIG: --workers 1 bleibt bewusst.
# Presence/Live-Cursor (routers/collaboration.py) halten ihren Zustand im
# Prozess. Mehrere Worker würden die Kollegen auf getrennte "Räume" verteilen.
# Parallelität für bis zu ~10 gleichzeitige Nutzer kommt aus dem Threadpool
# (sync-Endpoints) + dem größeren DB-Pool (database.py), nicht aus Workern.
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY} --proxy-headers --forwarded-allow-ips ${FORWARDED_ALLOW_IPS} --limit-concurrency ${UVICORN_LIMIT_CONCURRENCY} --timeout-keep-alive ${UVICORN_TIMEOUT_KEEP_ALIVE} --log-level ${LOG_LEVEL} --no-server-header"]
