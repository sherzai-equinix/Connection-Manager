"""app.py

FastAPI Entry.

Ziel:
- nur *eine* App-Instanz
- Router sauber registrieren
- CORS & Prefix zentral über config.py
"""

from fastapi import FastAPI, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse

from config import settings
from database import Base, engine
from security import get_current_user, require_permissions_for_write

# Router Imports
from routers.auth import router as auth_router
from routers.devices import router as devices_router
from routers.connections import router as connections_router
from routers.precabling import router as precabling_router
from routers.rackview import router as rackview_router
from routers.zside import router as zside_router
from routers.cross_connects import router as cross_connects_router
from routers.jobs import router as jobs_router
from routers.admin import router as admin_router
from routers.topology import router as topology_router
from routers.zside_lookup import router as zside_lookup_router
from routers import importer
from routers.migration_audit import router as migration_audit_router
from routers.kw_planning import router as kw_planning_router
from routers.kw_flow import router as kw_flow_router
from routers.patchpanels import router as patchpanels_router
from routers.historical_lines import router as historical_lines_router
from routers.presence import router as presence_router


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
app.include_router(devices_router, prefix=settings.api_prefix, tags=["devices"], dependencies=rbac_deps)
app.include_router(connections_router, prefix=settings.api_prefix, tags=["connections"], dependencies=rbac_deps)
app.include_router(topology_router, prefix=settings.api_prefix, tags=["topology"], dependencies=rbac_deps)

app.include_router(precabling_router, prefix=f"{settings.api_prefix}/precabling", tags=["precabling"], dependencies=rbac_deps)
app.include_router(rackview_router, prefix=f"{settings.api_prefix}/rackview", tags=["rackview"], dependencies=rbac_deps)
# zside_lookup_router provides helper endpoints like /patchpanels/{id}/ports.
# These must live under the same API prefix as the frontend expects.
app.include_router(patchpanels_router, dependencies=rbac_deps)
app.include_router(zside_lookup_router, prefix=settings.api_prefix, tags=["zside-lookup"], dependencies=rbac_deps)
app.include_router(importer.router, dependencies=rbac_deps)

# zside hat schon eigene prefix routes in router-file (oder nicht),
# also hier ohne prefix wie vorher
app.include_router(zside_router, dependencies=rbac_deps)

# ✅ cross-connects router hat prefix="/api/v1/cross-connects" schon im router-file
app.include_router(cross_connects_router, dependencies=rbac_deps)

# ✅ import-jobs (KW + Modus)
app.include_router(jobs_router, dependencies=rbac_deps)

# ✅ Migration Audit
app.include_router(migration_audit_router, dependencies=rbac_deps)
app.include_router(kw_planning_router, dependencies=rbac_deps)
app.include_router(kw_flow_router, dependencies=rbac_deps)
app.include_router(admin_router, dependencies=rbac_deps)
app.include_router(historical_lines_router, dependencies=rbac_deps)

# ✅ Live Presence (016) – kann sauber entfernt werden
app.include_router(presence_router)

# ------------------------------------------------------------
# Alias: /cross_connects/* → /cross-connects/* (Unterstrich → Bindestrich)
# Das Frontend nutzt teilweise cross_connects (Unterstrich), der Router hat cross-connects (Bindestrich)
# ------------------------------------------------------------
@app.get(f"{settings.api_prefix}/cross_connects/export", include_in_schema=False)
def cross_connects_export_redirect(request: Request):
    qs = str(request.url.query)
    target = f"{settings.api_prefix}/cross-connects/export"
    if qs:
        target += f"?{qs}"
    return RedirectResponse(url=target)

# ------------------------------------------------------------
# Frontend statisch serven (vermeidet CORS-Probleme bei file://)
# Zugriff: http://127.0.0.1:8000/
# ------------------------------------------------------------
@app.get("/", include_in_schema=False)
def redirect_to_login():
    return RedirectResponse(url="/frontend/login.html")

app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")

# ------------------------------------------------------------
# Debug: Routes anzeigen
# ------------------------------------------------------------
def print_all_routes():
    print("=" * 60)
    print("📋 REGISTRIERTE ENDPOINTS:")
    print("=" * 60)
    for route in app.routes:
        if hasattr(route, "path"):
            methods = getattr(route, "methods", None)
            print(f"  • {route.path} {methods}")
    print("=" * 60)

@app.on_event("startup")
async def startup_event():
    print_all_routes()

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
            "devices": f"{settings.api_prefix}/devices",
            "connections": f"{settings.api_prefix}/connections",
            "topology": f"{settings.api_prefix}/topology",
            "precabling": f"{settings.api_prefix}/precabling/links",
            "rackview": f"{settings.api_prefix}/rackview/patchpanel-rooms",
            "cross_connects": f"{settings.api_prefix}/cross-connects",
            "kw_plans": f"{settings.api_prefix}/kw-plans",
            "kw_plans_v2": f"{settings.api_prefix}/kw_plans",
            "kw_changes_v2": f"{settings.api_prefix}/kw_changes",
            "dashboard": f"{settings.api_prefix}/dashboard/stats",
            "patchpanels": f"{settings.api_prefix}/patchpanels",
            "zside": "/zside",
        },
    }

@app.get("/health")
def health_check(current_user=Depends(get_current_user)):
    return {"status": "healthy", "service": "connection-manager"}
