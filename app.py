"""app.py

FastAPI Entry.

Ziel:
- nur *eine* App-Instanz
- Router sauber registrieren
- CORS & Prefix zentral über config.py
"""

from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse

from config import settings
from database import Base, engine, get_db
from security import get_current_user, require_permissions_for_write
from sqlalchemy.orm import Session

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


# ------------------------------------------------------------
# FastAPI App erstellen (NUR EINMAL!)
# ------------------------------------------------------------
app = FastAPI(
    title="Connection Manager API",
    description="API zur Verwaltung von Netzwerkgeräten, Verbindungen und Pre-Cabling",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ------------------------------------------------------------
# DB Tables (einmal)
# ------------------------------------------------------------
Base.metadata.create_all(bind=engine)

# ------------------------------------------------------------
# One-time fix: remove duplicate PP prefixes
# e.g. PP:0102:PP:0102:1406994 → PP:0102:1406994
# ------------------------------------------------------------
def _fix_duplicate_pp_prefixes():
    from sqlalchemy import text as _t
    # patchpanel_instances.instance_id – the main source of the duplicate
    try:
        with engine.begin() as conn:
            conn.execute(_t("""
                UPDATE patchpanel_instances
                SET instance_id = regexp_replace(instance_id, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\\1', 'i')
                WHERE instance_id ~* '^PP:[^:]+:PP:'
            """))
    except Exception:
        pass

    # patchpanel_instances.pp_number – strip all PP: prefixes to bare number
    try:
        with engine.begin() as conn:
            conn.execute(_t("""
                UPDATE patchpanel_instances
                SET pp_number = regexp_replace(pp_number, '^(PP[:.][^:]*:)+', '', 'i')
                WHERE pp_number ~* '^PP[.:]'
            """))
            conn.execute(_t("""
                UPDATE patchpanel_instances
                SET pp_number = regexp_replace(pp_number, '^PP[:.] *', '', 'i')
                WHERE pp_number ~* '^PP[.:]'
            """))
    except Exception:
        pass

    # historical_lines.z_side
    try:
        with engine.begin() as conn:
            conn.execute(_t("""
                UPDATE historical_lines
                SET z_side = regexp_replace(z_side, '^(PP:[^:]+:)(?:PP:[^:]+:)+', '\\1', 'i')
                WHERE z_side ~* '^PP:[^:]+:PP:'
            """))
    except Exception:
        pass

    # kw_changes.payload_json contains customer_patchpanel_instance_id as JSONB
    try:
        with engine.begin() as conn:
            conn.execute(_t("""
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
            """))
    except Exception:
        pass

_fix_duplicate_pp_prefixes()

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
from routers.cross_connects import export_cross_connects_xlsx as _cc_export_fn

@app.get(f"{settings.api_prefix}/cross_connects/export", include_in_schema=False)
def cc_export_alias(
    status: str = "active",
    q: str = None,
    db: Session = Depends(get_db),
):
    return _cc_export_fn(status=status, q=q, db=db)

# ------------------------------------------------------------
# Frontend statisch serven (vermeidet CORS-Probleme bei file://)
# Zugriff: http://127.0.0.1:8000/
# ------------------------------------------------------------
@app.get("/", include_in_schema=False)
def redirect_to_login():
    return RedirectResponse(url="/frontend/login.html")

app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")

# ------------------------------------------------------------
# Root + Health
# ------------------------------------------------------------
@app.get("/")
def root(current_user=Depends(get_current_user)):
    return {
        "message": "Connection Manager API",
        "version": "1.0.0",
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

@app.get("/health")
def health_check(current_user=Depends(get_current_user)):
    return {"status": "healthy", "service": "connection-manager"}
