"""`client.vars.*` — typed variables, addressed the way the server addresses them.

The module is spelled with a leading underscore because the public attribute it
backs is `client.vars`, and a module-scope name of `vars` would read like the
builtin. The namespace class itself is public and exported from the barrel.

Six operations, **one HTTP call each**. Create by `name`, read by id or by name,
update and delete by id (`docs/implementation.md` §7, D6 amended by D12). No
client-side list-then-filter: :meth:`VarsApi.get_by_name` targets a real route,
`GET /vars/by-name/{name}`, served since 2026-07-28. Names are regex-validated
(`^[a-z_][a-z0-9_]*$`) at create time and so are URL-safe by construction —
unlike a document's free-form key, there is no dot-segment hazard here.

**There is no scoping query parameter on any variable operation, and this module
cannot invent one.** Variables are scoped by tenant/subject only: the server's
`vars` routes read no such parameter and the table has no column for it, while
every document route does — so the two asset surfaces are deliberately
asymmetric (`docs/implementation.md` §7; `documents.py` is the other half).

The asymmetry is enforced **by the narrow host type and by the tests, rather
than by discipline**. :class:`VarsApi` is handed the client's bound `request`
method and *nothing else*: it **holds** no configuration, and :class:`VarsRequest`
is a bare callable, so a type checker rejects the day someone widens this
namespace to take a client in order to read a default from it.

**It is not a capability barrier, and this file used to claim it was**
(overstated in T2.3.3; corrected 2026-07-27 under T2.3.4). A bound method carries
its instance, so `self._request.__self__` *is* the client and `config` is one hop
away — measured, not assumed. What actually holds the line is the pair above plus
`tests/test_vars.py`, which asserts on the **wire**: every one of the six
operations is called with a default project configured and no query string may
appear on any of them. A later edit that walked the hop would fail there,
whatever route it took to the value.

Adding the parameter once the server honours it is purely additive; adding it now
would be an argument the server ignores — a lie that typechecks.
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Protocol, Union

from ._http import HttpResponse, path
from .types import (
    UNSET,
    PatchableStr,
    Unset,
    Var,
    VarType,
    patch_body,
    unwrap_list,
    unwrap_object,
)


class VarsRequest(Protocol):
    """The single capability this namespace is given: send one request.

    A callable, not an object with a `request` method, and that is the point —
    see the module docstring. `Client.request` satisfies it as a bound
    method, and so does a three-line fake in a test.
    """

    def __call__(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> HttpResponse:
        """Perform one request.

        :param method: HTTP method.
        :param path: Base-relative path.
        :param query: Query parameters; `None` values are dropped.
        :param body: Request body, serialised as JSON.
        :returns: The status and parsed body.
        """
        ...  # pragma: no cover - a protocol body is never executed.


class VarsApi:
    """The `vars` namespace on a `Client`.

    Reached as `client.vars`; never constructed directly by a caller.

    Example::

        v = client.vars.create("sender_email", "string", "a@b.c")
        client.vars.update(v.id, value="c@d.e")
        client.vars.delete(v.id)
    """

    def __init__(self, request: VarsRequest) -> None:
        """Bind the namespace to a transport — and to nothing else.

        :param request: The client's bound `request` method.
        """
        self._request = request

    def list(self) -> List[Var]:
        """List the caller's variables.

        :returns: The variables, unwrapped from the `vars` envelope.
        :raises ConfigError: When no token is configured.
        :raises ApiError: On any non-2xx.
        """
        response = self._request("GET", "/vars")
        return [Var.from_wire(item) for item in unwrap_list(response, "vars")]

    def get(self, id: str) -> Var:
        """Fetch one variable by its server-issued id.

        :param id: The `var_…` id.
        :returns: The variable.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_var` when there is no such id.
        """
        response = self._request("GET", path("/vars/{id}", id=id))
        # The singular envelope key is `var` — a reserved word in the `node`
        # lane, and the builtin `vars` shadow risk in this one. It is read as a
        # string key, never bound to a name.
        return Var.from_wire(unwrap_object(response, "var"))

    def get_by_name(self, name: str) -> Var:
        """Fetch one variable by the `name` its author chose.

        The name is percent-encoded at interpolation by :func:`w6w.path`. The
        server's own rule (`^[a-z_][a-z0-9_]*$`) contains nothing that needs
        encoding — but that rule is the *server's* to enforce, and this method
        encodes rather than validates: a name the server accepts is sent as-is
        (encoded), and a name it rejects comes back as `400 invalid_name` from
        the one place that owns the rule, instead of as a client-side error that
        would go stale the moment the rule changed.

        :param name: The variable name, sent encoded and otherwise untouched.
        :returns: The variable.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_var` when there is no such name.
        """
        response = self._request("GET", path("/vars/by-name/{name}", name=name))
        return Var.from_wire(unwrap_object(response, "var"))

    def create(
        self,
        name: str,
        type: VarType,
        value: Any,
        description: Optional[str] = None,
    ) -> Var:
        """Create a typed variable under a caller-chosen name.

        Addressed by `name`, because that is how the server addresses a create
        (D6).

        `value` is **always sent**, including when it is `None`: for a variable
        of type `"json"`, `null` is a legitimate stored value, so dropping it
        would make one of the four types partly unusable. `description` is the
        only optional field, and there `None` means *omitted* — a create has no
        prior value to preserve, so "leave it alone" and "do not send it" are
        the same request. The distinction that does matter lives on
        :meth:`update`, which uses :data:`w6w.UNSET`.

        :param name: Must match `^[a-z_][a-z0-9_]*$` (`400 invalid_name`).
        :param type: One of `"string"`, `"number"`, `"boolean"`, `"json"`.
        :param value: The value, validated server-side against `type`
            (`400 invalid_value`).
        :param description: Free text.
        :returns: The created variable — the server answers `201`, which is
            success and is not special-cased anywhere.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `409 var_exists` on a duplicate name — the code
            reaches the caller intact, never flattened into a generic error.
        """
        body: Dict[str, Any] = {"name": name, "type": type, "value": value}
        if description is not None:
            body["description"] = description
        response = self._request("POST", "/vars", body=body)
        return Var.from_wire(unwrap_object(response, "var"))

    def update(
        self,
        id: str,
        type: Union[VarType, None, Unset] = UNSET,
        value: Any = UNSET,
        description: PatchableStr = UNSET,
    ) -> Var:
        """Patch a variable's type, value or description.

        Addressed by id, never by name, and **the name itself cannot be
        changed** — there is no `name` parameter here because there is no `name`
        in the server's PATCH body. A `value` sent without a `type` is validated
        against the variable's existing type.

        Each patchable field defaults to :data:`w6w.UNSET`, meaning *not sent*.
        Passing `None` is a different instruction: it sends JSON `null`. This is
        the operation the distinction exists for — the server tests
        `body.value !== undefined`, and for a `"json"` variable `null` is a
        value you can legitimately store::

            client.vars.update(var_id, value=42)      # {"value": 42}
            client.vars.update(var_id, value=None)    # {"value": null}
            client.vars.update(var_id)                # {}

        A signature that defaulted `value` to `None` could not express the
        middle line without permanently losing the last one — and would turn
        every "don't touch this field" into "null this field", silently.

        :param id: The `var_…` id.
        :param type: Replacement type, or `None` for JSON `null`.
        :param value: Replacement value, or `None` for JSON `null`.
        :param description: Replacement description, or `None` for JSON `null`.
        :returns: The updated variable.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_var` when there is no such id.
        """
        response = self._request(
            "PATCH",
            path("/vars/{id}", id=id),
            body=patch_body({"type": type, "value": value, "description": description}),
        )
        return Var.from_wire(unwrap_object(response, "var"))

    def delete(self, id: str) -> None:
        """Delete a variable.

        Returns nothing. The server's `{"ok": true}` carries no information a
        caller can use. Deleting an unknown id is `404 unknown_var`, **not** a
        silent success: the delete is not idempotent and this method does not
        pretend otherwise.

        :param id: The `var_…` id.
        :raises ConfigError: When no token is configured.
        :raises ApiError: `404 unknown_var` when there is no such id.
        """
        self._request("DELETE", path("/vars/{id}", id=id))
