"""app.py

FastAPI Entry.

Ziel:
- nur *eine* App-Instanz
- Router sauber registrieren
- CORS & Prefix zentral über config.py

Neu (2026-10 – Stabilität für Mehrbenutzerbetrieb):
- Startup wartet kontrolliert auf die Datenbank (statt beim ersten Verbindungs-
  fehler zu sterben) und protokolliert die Einmal-Bereinigungen statt sie
  still zu schlucken.
- /health (Liveness) und /health/ready (DB-Check) sind ohne Login erreichbar,
  damit Docker-Healthchecks, Portainer und das Frontend den Zustand sehen.
- GZip für API- und Frontend-Antworten, Security-Header, Cache-Revalidierung
  für das Frontend (kein Strg+F5 mehr nach einem Redeploy).
- Langsame Requests (> 2s) werden geloggt.
- Der doppelte, nie erreichbare "/"-Handler wurde entfernt; die API-Übersicht
  liegt jetzt unter /api.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text as _sql_text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from config import settings
from database import Base, engine, get_db
from security import get_current_user, require_permissions_for_write

# Router Imports
from routers.auth import router as auth_router
from routers.rackview import router as rackview_router
from routers.cross_connects import router as cross_connects_router
from routers.admin import router as admin_router
from routers.migration_audit import router as migration_audit_router
from routers.kw_planning import router as kw_planning_router
from routers.kw_flow import router as kw_flow_router
from routers.patchpanels import router as patchpanels_router
from routers.historical_lines import router as historical_lines_router
from routers.troubleshooting import router as troubleshooting_router
from routers.access_restrictions import router as access_restrictions_router
from routers.collaboration import router as collaboration_router

log = logging.getLogger("cm.app")

APP_VERSION = settings.app_version
SLOW_REQUEST_SECONDS = 2.0


# ------------------------------------------------------------
# Datenbank: warten, Tabellen anlegen, Einmal-Bereinigungen
# ------------------------------------------------------------
def _wait_for_db() -> None:
    """Blockiert den Start, bis Postgres Verbindungen annimmt.

    Compose startet das Backend zwar erst nach dem Postgres-Healthcheck, aber
    bei einem Neustart des DB-Containers im laufenden Betrieb (Update, OOM,
    VM-Reboot) soll das Backend nicht sofort sterben, sondern kurz warten.
    """
    attempts = max(1, settings.db_connect_retries)
    for attempt in range(1, attempts + 1):
        try:
            with engine.connect() as conn:
                conn.execute(_sql_text("SELECT 1"))
            if attempt > 1:
                log.info("Datenbank erreichbar (Versuch %s/%s).", attempt, attempts)
            return
        except OperationalError as exc:
            if attempt == attempts:
                log.error("Datenbank nach %s Versuchen nicht erreichbar: %s", attempts, exc)
                raise
            log.warning(
                "Datenbank noch nicht erreichbar (Versuch %s/%s) – warte 2s …",
                attempt,
                attempts,
            )
            time.sleep(2)


def _fix_duplicate_pp_prefixes() -> None:
    """One-time fix: remove duplicate PP prefixes.

    z. B. PP:0102:PP:0102:1406994 → PP:0102:1406994

    Alle Statements sind idempotent und laufen bei jedem Start. Fehler
    (z. B. fehlende Legacy-Tabelle) werden geloggt statt verschluckt, damit
    man im Container-Log sieht, ob etwas nicht gepasst hat.
    """
    steps: list[tuple[str, list[str]]] = [
        (
            "patchpanel_instances.instance_id",
            [
                """
                UPDATE patchpanel_instances
                SET instance_id = regexp_replace(instance_id, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\\1', 'i')
                WHERE instance_id ~* '^PP:[^:]+:PP:'
                """,
            ],
        ),
        (
            "patchpanel_instances.pp_number",
            [
                """
                UPDATE patchpanel_instances
                SET pp_number = regexp_replace(pp_number, '^(PP[:.][^:]*:)+', '', 'i')
                WHERE pp_number ~* '^PP[.:]'
                """,
                """
                UPDATE patchpanel_instances
                SET pp_number = regexp_replace(pp_number, '^PP[:.] *', '', 'i')
                WHERE pp_number ~* '^PP[.:]'
                """,
            ],
        ),
        (
            "historical_lines.z_side",
            [
                """
                UPDATE historical_lines
                SET z_side = regexp_replace(z_side, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\\1', 'i')
                WHERE z_side ~* '^PP:[^:]+:PP:'
                """,
            ],
        ),
        (
            "kw_changes.payload_json.customer_patchpanel_instance_id",
            [
                """
                UPDATE kw_changes
                SET payload_json = jsonb_set(
                    payload_json,
                    '{customer_patchpanel_instance_id}',
                    to_jsonb(regexp_replace(
                        payload_json->>'customer_patchpanel_instance_id',
                        '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\\1', 'i'
                    ))
                )
                WHERE payload_json->>'customer_patchpanel_instance_id' ~* '^PP:[^:]+:PP:'
                """,
            ],
        ),
    ]

    for label, statements in steps:
        try:
            with engine.begin() as conn:
                changed = 0
                for stmt in statements:
                    result = conn.execute(_sql_text(stmt))
                    if result.rowcount and result.rowcount > 0:
                        changed += result.rowcount
            if changed:
                log.info("PP-Präfix-Bereinigung %s: %s Zeilen korrigiert.", label, changed)
        except Exception as exc:  # noqa: BLE001 – bewusst breit: Start darf nicht scheitern
            log.warning("PP-Präfix-Bereinigung %s übersprungen: %s", label, exc)


def _init_database() -> None:
    _wait_for_db()
    Base.metadata.create_all(bind=engine)
    _fix_duplicate_pp_prefixes()


# Wie bisher beim Import (Tests und Skripte verlassen sich darauf, dass die
# Tabellen nach `import app` existieren) – nur jetzt mit Warten + Logging.
_init_database()


# ------------------------------------------------------------
# Lifespan: sauberes Hoch- und Herunterfahren
# ------------------------------------------------------------
@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info(
        "Connection Manager %s gestartet – API-Prefix %s, Frontend unter /frontend",
        APP_VERSION,
        settings.api_prefix,
    )
    yield
    # Offene Pool-Verbindungen sauber schließen, damit Postgres beim Redeploy
    # keine verwaisten Sessions behält.
    engine.dispose()
    log.info("Connection Manager gestoppt.")


# ------------------------------------------------------------
# FastAPI App erstellen (NUR EINMAL!)
# ------------------------------------------------------------
app = FastAPI(
    title="Connection Manager API",
    description="API zur Verwaltung von Netzwerkgeräten, Verbindungen und Pre-Cabling",
    version=APP_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)


# ------------------------------------------------------------
# Middleware (Reihenfolge: zuletzt hinzugefügt = äußerste Schicht)
# ------------------------------------------------------------
class RequestHardeningMiddleware:
    """Reines ASGI-Middleware (kein BaseHTTPMiddleware → kein Buffering von
    Streaming-Antworten wie dem Excel-Export).

    - Security-Header auf jeder HTTP-Antwort
    - Cache-Revalidierung für /frontend/*: Browser fragt mit ETag nach, bekommt
      304 wenn unverändert – neue Versionen erscheinen ohne Strg+F5
    - Loggt Requests, die länger als SLOW_REQUEST_SECONDS dauern
    """

    _SECURITY_HEADERS = (
        (b"x-content-type-options", b"nosniff"),
        (b"x-frame-options", b"SAMEORIGIN"),
        (b"referrer-policy", b"strict-origin-when-cross-origin"),
    )

    def __init__(self, app):  # noqa: D107
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope.get("path", "")
        started = time.perf_counter()

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                existing = {k.lower() for k, _ in headers}
                for key, value in self._SECURITY_HEADERS:
                    if key not in existing:
                        headers.append((key, value))
                if path.startswith("/frontend/") and b"cache-control" not in existing:
                    headers.append((b"cache-control", b"no-cache"))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            elapsed = time.perf_counter() - started
            if elapsed >= SLOW_REQUEST_SECONDS:
                log.warning(
                    "Langsamer Request: %s %s dauerte %.1fs",
                    scope.get("method", "?"),
                    path,
                    elapsed,
                )


def _cors_config():
    """CORS Defaults.

    Wichtig: allow_credentials + "*" funktioniert im Browser nicht sauber.
    Deshalb: Wenn du CORS_ORIGINS nicht setzt, nehmen wir ein sinnvolles
    Default-Set (localhost live-server etc.).
    """
    if settings.cors_origins:
        origins = list(settings.cors_origins)
    else:
        origins = list(settings.cors_default_origins)

    allow_credentials = True
    if "*" in origins:
        # Browser erlauben credentials nicht mit wildcard.
        allow_credentials = False

    return origins, allow_credentials


origins, allow_credentials = _cors_config()

# Innen → außen: GZip komprimiert, Hardening setzt Header, CORS ganz außen,
# damit Preflight-Antworten korrekt sind.
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(RequestHardeningMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------
# Router registrieren (einmal)
# Wichtig: Prefix nur hier setzen
# ------------------------------------------------------------
rbac_deps = [Depends(require_permissions_for_write("audit:write"))]

app.include_router(auth_router)
app.include_router(rackview_router, prefix=f"{settings.api_prefix}/rackview", tags=["rackview"], dependencies=rbac_deps)
app.include_router(patchpanels_router, dependencies=rbac_deps)
app.include_router(cross_connects_router, dependencies=rbac_deps)
app.include_router(migration_audit_router, dependencies=rbac_deps)
app.include_router(kw_planning_router, dependencies=rbac_deps)
app.include_router(kw_flow_router, dependencies=rbac_deps)
app.include_router(admin_router, dependencies=rbac_deps)
app.include_router(historical_lines_router, dependencies=rbac_deps)
app.include_router(troubleshooting_router, dependencies=rbac_deps)
app.include_router(access_restrictions_router, dependencies=rbac_deps)
app.include_router(collaboration_router)


# ------------------------------------------------------------
# Alias: /cross_connects/export (Unterstrich-Version)
# Das Frontend (cross-connects.js) nutzt API_CROSSCONNECTS_MIN = /cross_connects
# Der Router registriert unter /cross-connects (Bindestrich).
# Diese Route leitet den Aufruf direkt an die Export-Funktion weiter.
# ------------------------------------------------------------
from routers.cross_connects import export_cross_connects_xlsx as _cc_export_fn  # noqa: E402


@app.get(
    f"{settings.api_prefix}/cross_connects/export",
    include_in_schema=False,
    dependencies=rbac_deps,
)
def cc_export_alias(
    status: str = "active",
    q: str | None = None,
    db: Session = Depends(get_db),
):
    return _cc_export_fn(status=status, q=q, db=db)


# ------------------------------------------------------------
# Health (ohne Login – nur Status, keine Daten)
# ------------------------------------------------------------
@app.get("/health", include_in_schema=False)
def health_live():
    """Liveness: Prozess läuft und beantwortet HTTP."""
    return {"status": "ok", "service": "connection-manager", "version": APP_VERSION}


@app.get("/health/ready", include_in_schema=False)
def health_ready():
    """Readiness: Datenbank antwortet. 503, wenn nicht – Docker/Portainer
    markieren den Container dann als unhealthy, das Frontend zeigt die
    Status-LED in der Navigation gelb/rot."""
    try:
        with engine.connect() as conn:
            conn.execute(_sql_text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001
        log.warning("Readiness-Check fehlgeschlagen: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "database": "unreachable", "version": APP_VERSION},
        )
    return {"status": "ok", "database": "ok", "version": APP_VERSION}


# ------------------------------------------------------------
# Frontend statisch serven (vermeidet CORS-Probleme bei file://)
# Zugriff: http://127.0.0.1:8000/
# ------------------------------------------------------------
@app.get("/", include_in_schema=False)
def redirect_to_login():
    return RedirectResponse(url="/frontend/login.html")


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


# ------------------------------------------------------------
# API-Übersicht (mit Login) – vorher ein nie erreichbarer zweiter "/"-Handler
# ------------------------------------------------------------
@app.get("/api", include_in_schema=False)
def api_overview(current_user=Depends(get_current_user)):
    return {
        "message": "Connection Manager API",
        "version": APP_VERSION,
        "docs": "/docs",
        "endpoints": {
            "rackview": f"{settings.api_prefix}/rackview/patchpanel-rooms",
            "cross_connects": f"{settings.api_prefix}/cross-connects",
            "kw_plans": f"{settings.api_prefix}/kw-plans",
            "kw_plans_v2": f"{settings.api_prefix}/kw_plans",
            "kw_changes_v2": f"{settings.api_prefix}/kw_changes",
            "dashboard": f"{settings.api_prefix}/dashboard/stats",
            "patchpanels": f"{settings.api_prefix}/patchpanels",
        },
    }
