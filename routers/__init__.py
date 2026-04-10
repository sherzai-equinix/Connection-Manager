"""routers package.

Dieses Projekt nutzt Router pro Feature.
"""

# (optional) convenience exports
from .devices import router as devices_router
from .connections import router as connections_router
from .precabling import router as precabling_router
from .rackview import router as rackview_router
from .zside import router as zside_router
from .cross_connects import router as cross_connects_router
from .jobs import router as jobs_router
from .topology import router as topology_router
from .kw_planning import router as kw_planning_router
from .historical_lines import router as historical_lines_router

__all__ = [
    "devices_router",
    "connections_router",
    "precabling_router",
    "rackview_router",
    "zside_router",
    "cross_connects_router",
    "jobs_router",
    "topology_router",
    "kw_planning_router",
    "historical_lines_router",
]
