"""Identifier normalisation shared by the persistence-backed agent modules."""

from __future__ import annotations

from uuid import NAMESPACE_DNS, UUID, uuid5


def to_uuid(val: str | UUID) -> UUID:
    """Return ``val`` as a UUID; any non-UUID string maps deterministically to a uuid5.

    Run ids are chosen by the client, so they are not guaranteed to be UUIDs while
    the database columns are.  The same input always maps to the same UUID, which
    lets the router, the graph and the confirmation flow agree on one execution id.
    """
    if isinstance(val, UUID):
        return val
    try:
        return UUID(str(val))
    except (ValueError, TypeError, AttributeError):
        return uuid5(NAMESPACE_DNS, str(val))

