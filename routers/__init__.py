"""routers package.

Dieses Projekt nutzt Router pro Feature.
"""

from .rackview import router as rackview_router
from .cross_connects import router as cross_connects_router
from .kw_planning import router as kw_planning_router
from .historical_lines import router as historical_lines_router

__all__ = [
    "rackview_router",
    "cross_connects_router",
    "kw_planning_router",
    "historical_lines_router",
]
