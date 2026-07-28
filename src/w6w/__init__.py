"""w6w — the official Python client for the w6w workflow API.

Typed, dependency-free, and stdlib-only: transport is `urllib.request`, tests
run under `unittest`. Nothing here imports a third-party module, and nothing
here ever will — see README "Zero runtime dependencies".

    import w6w
    print(w6w.__version__)

THE BARREL RULE
---------------
**Every public symbol of this package must be re-exported from this module and
listed in `__all__`.** `w6w.ApiError`, `w6w.Client`, `w6w.Doc`, … are the only
import paths users are promised; anything reachable only as
`w6w._transport.something` is private and may move without a major bump.
Modules whose names start with an underscore (`_version`, `_config`, `_vars`,
…) are implementation detail — the underscore is the signal, and `_vars` in
particular is spelled that way because the public attribute it backs is
`client.vars`, which would otherwise read like the `vars` builtin at module
scope.

The API surface itself (which operations exist, what each is called in each
language) is pinned by the wrappers' shared `endpoints.json` contract, not
decided here: three wrappers implement one surface, and they release together
at one version.
"""

from __future__ import annotations

from ._config import BASE_PATH, ResolvedConfig, join_base_url
from ._http import HttpResponse, Transport, path
from ._vars import VarsApi, VarsRequest
from ._version import __version__
from .client import W6wClient
from .connections import ConnectionsApi, ConnectionsRequest
from .documents import DocumentsApi, DocumentsHost
from .errors import ApiError, ConfigError
from .me import MeRequest, fetch_me
from .types import (
    UNSET,
    ConnectionState,
    ConnectionSummary,
    Doc,
    DocFormat,
    Me,
    PatchableStr,
    Unset,
    Var,
    VarType,
    WorkflowStatus,
    WorkflowSummary,
)
from .workflows import WorkflowsApi, WorkflowsHost

__all__ = [
    "ApiError",
    "BASE_PATH",
    "ConfigError",
    # Identity and discovery (T2.3.4). `connections.list` and `workflows.list`
    # are how a caller finds a URN to hand to `run` (D4); `me` is what makes a
    # bug report actionable.
    "ConnectionState",
    "ConnectionSummary",
    "ConnectionsApi",
    "ConnectionsRequest",
    # Asset operations (T2.3.3). The namespace classes are exported alongside
    # their wire types and host protocols because a host that types a helper
    # around `client.documents` needs to name them; they are reached through a
    # client, never constructed directly.
    "Doc",
    "DocFormat",
    "DocumentsApi",
    "DocumentsHost",
    "HttpResponse",
    "Me",
    "MeRequest",
    "PatchableStr",
    "ResolvedConfig",
    "Transport",
    # The omit-vs-null sentinel and its type. Public because a caller assembling
    # a patch programmatically has to be able to say "not this field" — `None`
    # already means "set this field to null", and the two must stay distinct.
    "UNSET",
    "Unset",
    "Var",
    "VarType",
    "VarsApi",
    "VarsRequest",
    "W6wClient",
    "WorkflowStatus",
    "WorkflowSummary",
    "WorkflowsApi",
    "WorkflowsHost",
    "__version__",
    # `client.me()` is a method rather than a namespace, so the function it
    # delegates to is the exported symbol — same layering as the namespaces.
    "fetch_me",
    "join_base_url",
    # Exported because `W6wClient.request` is public: a host reaching an
    # endpoint this version does not model yet must have the same
    # encoding-at-interpolation primitive the operation modules use, or it will
    # concatenate a caller value into a path by hand — the one bug the encoding
    # pin exists to prevent.
    "path",
]
