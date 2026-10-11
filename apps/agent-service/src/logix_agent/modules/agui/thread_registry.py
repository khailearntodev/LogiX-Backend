"""In-memory ownership of AG-UI threads.

Thread ids are chosen by the client, so the first actor to use an id owns it and
anyone else is told it does not exist.  Lives and dies with the in-memory
checkpointer; single-worker only.
"""

from __future__ import annotations

import re
from threading import Lock

from logix_agent.modules.auth import Actor

_THREAD_ID = re.compile(r"^[A-Za-z0-9_-]{8,100}$")


class ThreadNotFoundError(Exception):
    pass


class InvalidThreadIdError(ValueError):
    pass


class ThreadRegistry:
    def __init__(self) -> None:
        self._owners: dict[str, tuple[str, str]] = {}
        self._lock = Lock()

    def claim(self, thread_id: str, actor: Actor) -> None:
        if not _THREAD_ID.fullmatch(thread_id):
            raise InvalidThreadIdError(thread_id)
        owner = (actor.tenant_id, actor.user_id)
        with self._lock:
            existing = self._owners.setdefault(thread_id, owner)
        if existing != owner:
            raise ThreadNotFoundError(thread_id)
