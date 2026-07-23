"""Authenticated same-page collaboration over WebSockets.

The feature intentionally transports only presence, pointer positions and short
activity labels. Form values are never sent to other browsers.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from jose import JWTError, jwt

from config import settings
from database import SessionLocal
from security import JWT_ALGORITHM, _require_jwt_secret, get_user_by_username


router = APIRouter(
    prefix=f"{settings.api_prefix}/collaboration",
    tags=["collaboration"],
)

_PAGE_RE = re.compile(r"^[a-zA-Z0-9._-]{1,80}$")
_COLORS = (
    "#2563eb",
    "#7c3aed",
    "#db2777",
    "#ea580c",
    "#0891b2",
    "#059669",
    "#4f46e5",
    "#c026d3",
)


def _safe_text(value: Any, limit: int = 160) -> str:
    return " ".join(str(value or "").split())[:limit]


def _initials(name: str) -> str:
    parts = [part for part in name.replace("_", " ").replace("-", " ").split() if part]
    if not parts:
        return "?"
    return "".join(part[0].upper() for part in parts[:2])


def _color_for(username: str) -> str:
    digest = hashlib.sha256(username.encode("utf-8")).digest()
    return _COLORS[digest[0] % len(_COLORS)]


def _authenticate(token: str) -> dict[str, Any] | None:
    try:
        payload = jwt.decode(token, _require_jwt_secret(), algorithms=[JWT_ALGORITHM])
        username = str(payload.get("sub") or "").strip()
        if not username:
            return None
    except (JWTError, ValueError):
        return None

    db = SessionLocal()
    try:
        user = get_user_by_username(db, username)
        if not user or not user.get("is_active"):
            return None
        return dict(user)
    finally:
        db.close()


@dataclass
class Client:
    websocket: WebSocket
    page: str
    participant: dict[str, Any]


class CollaborationHub:
    def __init__(self) -> None:
        self._pages: dict[str, dict[WebSocket, Client]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def join(self, client: Client) -> None:
        async with self._lock:
            self._pages[client.page][client.websocket] = client
        await self.broadcast_roster(client.page)

    async def leave(self, client: Client) -> None:
        async with self._lock:
            page_clients = self._pages.get(client.page)
            if page_clients is not None:
                page_clients.pop(client.websocket, None)
                if not page_clients:
                    self._pages.pop(client.page, None)
        await self.broadcast_roster(client.page)

    async def _snapshot(self, page: str) -> list[Client]:
        async with self._lock:
            return list(self._pages.get(page, {}).values())

    async def broadcast_roster(self, page: str) -> None:
        clients = await self._snapshot(page)
        participants = [client.participant for client in clients]
        await self._send_many(
            clients,
            {"type": "presence", "participants": participants},
        )

    async def broadcast(self, sender: Client, payload: dict[str, Any]) -> None:
        clients = [
            client
            for client in await self._snapshot(sender.page)
            if client.websocket is not sender.websocket
        ]
        message = {**payload, "participant": sender.participant}
        await self._send_many(clients, message)

    async def _send_many(self, clients: list[Client], payload: dict[str, Any]) -> None:
        if not clients:
            return
        results = await asyncio.gather(
            *(client.websocket.send_json(payload) for client in clients),
            return_exceptions=True,
        )
        stale = [
            client
            for client, result in zip(clients, results)
            if isinstance(result, Exception)
        ]
        if stale:
            async with self._lock:
                for client in stale:
                    self._pages.get(client.page, {}).pop(client.websocket, None)


hub = CollaborationHub()


@router.websocket("/ws")
async def collaboration_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    client: Client | None = None

    try:
        try:
            auth_message = await asyncio.wait_for(websocket.receive_json(), timeout=8)
        except (asyncio.TimeoutError, ValueError):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        if not isinstance(auth_message, dict) or auth_message.get("type") != "auth":
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        page = _safe_text(auth_message.get("page"), 80)
        token = str(auth_message.get("token") or "")
        user = _authenticate(token)
        if not user or not _PAGE_RE.fullmatch(page):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        username = _safe_text(user.get("username"), 100)
        display_name = _safe_text(user.get("full_name") or username, 100)
        participant = {
            "connection_id": uuid.uuid4().hex,
            "id": int(user["id"]),
            "username": username,
            "name": display_name,
            "initials": _initials(display_name),
            "color": _color_for(username),
        }
        client = Client(websocket=websocket, page=page, participant=participant)
        await websocket.send_json({"type": "ready", "participant": participant})
        await hub.join(client)

        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                continue
            message_type = str(message.get("type") or "")

            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if message_type in {"cursor", "click"}:
                try:
                    x = min(1.0, max(0.0, float(message.get("x", 0))))
                    y = min(1.0, max(0.0, float(message.get("y", 0))))
                except (TypeError, ValueError):
                    continue
                await hub.broadcast(
                    client,
                    {
                        "type": message_type,
                        "x": x,
                        "y": y,
                        "target": _safe_text(message.get("target"), 100),
                    },
                )
                continue

            if message_type in {"activity", "data_changed"}:
                await hub.broadcast(
                    client,
                    {
                        "type": message_type,
                        "action": _safe_text(message.get("action"), 160),
                        "target": _safe_text(message.get("target"), 120),
                        "method": _safe_text(message.get("method"), 12),
                        "path": _safe_text(message.get("path"), 240),
                    },
                )
    except (WebSocketDisconnect, RuntimeError, TypeError, ValueError):
        pass
    finally:
        if client is not None:
            await hub.leave(client)
