"""Errors raised during confirmation gate handling."""

from __future__ import annotations


class ConfirmationError(Exception):
    """Base error for confirmation gate operations."""


class ConfirmationNotFoundError(ConfirmationError):
    """Approval ID does not exist for the given tenant."""


class ConfirmationAccessDeniedError(ConfirmationError):
    """Actor does not have authority to approve or reject this request."""


class ConfirmationExpiredError(ConfirmationError):
    """Confirmation request has expired and can no longer be acted upon."""


class ConfirmationStateError(ConfirmationError):
    """Confirmation request is not in the expected status (e.g. replay attempt)."""


class ConfirmationStaleVersionError(ConfirmationError):
    """Target entity version changed between preview and approval."""
