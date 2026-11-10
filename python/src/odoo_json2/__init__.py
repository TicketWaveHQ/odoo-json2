"""odoo-json2: a small, dependency-free client for Odoo's External JSON-2 API."""

from .client import (
    READ_ONLY_METHODS,
    OdooClient,
    OdooConfigError,
    OdooError,
    OdooHTTPError,
    OdooNetworkError,
    OdooResponseError,
    OdooTimeoutError,
    __version__,
    client_from_env,
)

__all__ = [
    "READ_ONLY_METHODS",
    "OdooClient",
    "OdooConfigError",
    "OdooError",
    "OdooHTTPError",
    "OdooNetworkError",
    "OdooResponseError",
    "OdooTimeoutError",
    "__version__",
    "client_from_env",
]
