"""Conformance: the published surface, checked against the shared contract.

Two gates live here, and nothing else in this suite can see either of them.

**1. The contract gate** (`docs/implementation.md` §10, `docs/parity.md`
§Conformance). `../endpoints.json` — the sibling of this repo, read from THIS
FILE's location and never from the process working directory — names every
operation all three wrappers must expose, and the symbol each language must
expose it as. This file walks that list and asserts the symbol is reachable and
callable on a constructed client. It is the drift alarm for the actual failure
mode the lockstep bet exists to prevent: **an operation added to two wrappers and
forgotten in the third.**

It **exempts nothing**. `status` records *server* readiness, not wrapper
obligation, so a `planned` operation is asserted exactly like a `required` one.
And it asserts in **both directions** — every contracted operation exists, and no
namespace has grown one the contract does not have. "Same methods, no more no
less" is not a property a one-directional check can hold.

If the contract is missing the test **FAILS naming the path it looked for**; it
never skips, and it never falls back to a copy vendored inside this repo. A guard
that quietly passes when its input is missing is worse than no guard, and a
vendored copy goes stale silently — which defeats the whole mechanism. A
standalone clone therefore has to check the contract out beside it, which is
exactly what its CI job does.

**2. The barrel gate.** Every other test file imports from `w6w` already, but
none of them would notice a name dropped from `__all__` — the module would keep
working and `from w6w import *` would silently stop offering it. The set is
pinned here, exactly, so an export added without a line here is as visible as one
deleted.

No case below makes a network call: the client is constructed with a dummy base
URL and token, and nothing is invoked.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

import w6w
from w6w import Client

_REPO_ROOT = Path(__file__).resolve().parent.parent
#: The shared contract, beside this repo — `packages/wrappers/endpoints.json`.
_CONTRACT = _REPO_ROOT.parent / "endpoints.json"

#: Every public name this package promises. Adding an operation means adding its
#: export to `__init__.py` **and** its name here, in the same change — that is
#: the point, not friction.
PUBLIC_SURFACE = {
    # The Function and Workflow definition lifecycle: the list/get projections,
    # and what the two upsert routes answer with.
    "FunctionDetail",
    "FunctionSummary",
    "SaveResult",
    "WorkflowDetail",
    "WorkflowSaveResult",
    # The version, in lockstep across all three wrappers.
    "__version__",
    # Transport core: the client, its configuration, its seams, the errors.
    "Client",
    "ApiError",
    "ConfigError",
    "BASE_PATH",
    "ResolvedConfig",
    "Transport",
    "HttpResponse",
    "join_base_url",
    "path",
    # Assets.
    "DocumentsApi",
    "DocumentsHost",
    "VarsApi",
    "VarsRequest",
    "Doc",
    "DocFormat",
    "Var",
    "VarType",
    # The omit-vs-null sentinel: a caller assembling a patch has to be able to
    # say "not this field" separately from "set this field to null".
    "UNSET",
    "Unset",
    "PatchableStr",
    # Identity and discovery.
    "fetch_me",
    "MeRequest",
    "Me",
    "ConnectionsApi",
    "ConnectionsRequest",
    "ConnectionState",
    "ConnectionSummary",
    "WorkflowsApi",
    "WorkflowsHost",
    "WorkflowStatus",
    "WorkflowSummary",
    # Name-addressed run: the sibling shape of `workflows.run`, with the name
    # as the first argument rather than a field inside an options object.
    "FunctionsApi",
    "FunctionsHost",
    "EndpointsApi",
    "EndpointsHost",
    # Execution.
    "run_urn",
    "RunRequest",
    "RunEnvelope",
    "RunResult",
    "RunStatus",
    "StepError",
    "WorkflowRunResult",
    "is_action_run",
    "is_function_run",
    "is_workflow_run",
    "is_terminal_run_status",
}


def _contract() -> Dict[str, Any]:
    """Read the shared contract, or fail loudly naming where it looked.

    :returns: The parsed `endpoints.json`.
    :raises AssertionError: When the contract is not beside this repo.
    """
    if not _CONTRACT.is_file():
        raise AssertionError(
            "conformance: the wrappers' shared contract was not found at "
            "{path}. This repo is checked out beside it (endpoints.json, "
            "VERSION); check it out there rather than vendoring a copy — a "
            "vendored contract goes stale silently and defeats the "
            "mechanism.".format(path=_CONTRACT),
        )
    return json.loads(_CONTRACT.read_text(encoding="utf-8"))


def _attribute_path(naming: str) -> List[str]:
    """Resolve a `naming.python` string to the attribute path it names.

    Pinned by `docs/implementation.md` §10 so all three runners agree:

    1. truncate at the first `(`;
    2. drop the leading `client.`;
    3. split the remainder on `.`.

    ::

        "client.documents.get_by_key(key, project=None)" -> ["documents", "get_by_key"]

    :param naming: The `naming.python` entry of one operation.
    :returns: The attribute path from a client instance.
    """
    symbol = naming.split("(", 1)[0].strip()
    prefix = "client."
    if symbol.startswith(prefix):
        symbol = symbol[len(prefix):]
    return symbol.split(".")


def _operations() -> List[Tuple[str, str, List[str]]]:
    """Every contracted operation, as (name, naming string, attribute path)."""
    return [
        (op["name"], op["naming"]["python"], _attribute_path(op["naming"]["python"]))
        for op in _contract()["operations"]
    ]


def _public_callables(namespace: Any) -> Set[str]:
    """The public methods of a namespace object.

    Underscored names are implementation detail by this package's own
    convention, so they are not part of what "no more no less" is measured
    against.

    :param namespace: A namespace instance, e.g. `client.documents`.
    :returns: The public callable attribute names.
    """
    return {
        name
        for name in dir(namespace)
        if not name.startswith("_") and callable(getattr(namespace, name))
    }


def _client() -> Client:
    """A client built from dummy configuration. No request is ever made."""
    return Client(base_url="https://api.example.com", token="tok_conformance")


class ContractTest(unittest.TestCase):
    """The contract is readable, and it is the seventeen operations we think."""

    def test_the_contract_is_found_beside_this_repo_and_parses(self) -> None:
        contract = _contract()

        self.assertIn("operations", contract)
        self.assertTrue(contract["operations"], "the contract lists no operations")

    def test_every_operation_declares_a_python_naming_entry(self) -> None:
        # A missing `naming.python` would make the walk below silently skip an
        # operation — the exact hole this runner exists to close.
        for operation in _contract()["operations"]:
            with self.subTest(operation=operation["name"]):
                self.assertIn("python", operation.get("naming", {}))


class ReachabilityTest(unittest.TestCase):
    """Every contracted operation is reachable on a constructed client."""

    def test_every_operation_resolves_to_a_callable_regardless_of_status(self) -> None:
        client = _client()
        missing: List[str] = []

        for name, naming, attributes in _operations():
            target: Any = client
            for step in attributes:
                if not hasattr(target, step):
                    missing.append(
                        "conformance: operation `{name}` is not reachable — expected "
                        "`{naming}` (from endpoints.json naming.python)".format(
                            name=name,
                            naming=naming,
                        ),
                    )
                    break
                target = getattr(target, step)
            else:
                if not callable(target):
                    missing.append(
                        "conformance: operation `{name}` resolves to a non-callable "
                        "`{naming}`".format(name=name, naming=naming),
                    )

        self.assertEqual(missing, [], "\n".join(missing))

    def test_a_planned_operation_is_asserted_exactly_like_a_required_one(self) -> None:
        # The runner exempts nothing, and this case is what keeps that true if
        # an operation ever goes back to `planned`: `status` is about the
        # SERVER, and a wrapper that skipped an operation "because it is
        # planned" would ship a surface silently different from its siblings.
        statuses = {op.get("status") for op in _contract()["operations"]}

        self.assertTrue(statuses <= {"required", "planned"}, statuses)
        # Whatever the mix is, the walk above covered every one of them.
        self.assertEqual(
            len(_operations()),
            len(_contract()["operations"]),
            "an operation was dropped between reading the contract and walking it",
        )


class NoExtraOperationsTest(unittest.TestCase):
    """…and nothing beyond them. The other direction of "same surface"."""

    def test_each_namespace_exposes_exactly_its_contracted_operations(self) -> None:
        # A namespace that grew a method the other two lanes do not have is
        # drift in the direction a reachability check cannot see. `endpoints.json`
        # is the arbiter in both directions.
        expected: Dict[str, Set[str]] = {}
        for _name, _naming, attributes in _operations():
            if len(attributes) == 2:
                expected.setdefault(attributes[0], set()).add(attributes[1])

        client = _client()
        for namespace, operations in expected.items():
            with self.subTest(namespace=namespace):
                self.assertEqual(_public_callables(getattr(client, namespace)), operations)

    def test_the_client_exposes_the_root_operations_plus_the_transport_seam(self) -> None:
        # `me` and `run` are methods on the client itself (that is what their
        # `naming.python` says). Two non-operation callables are allowed and
        # both are deliberate: `request`, the public seam a host uses to reach
        # an endpoint this version does not model yet, and `transport`, the
        # injected opener — callable because it *is* a callable, and public
        # because a language with no private fields documents a seam rather than
        # hiding it. Nothing else on the client is callable.
        root = {attributes[0] for _n, _s, attributes in _operations() if len(attributes) == 1}

        self.assertEqual(root, {"me", "run"})
        self.assertEqual(_public_callables(_client()) - root, {"request", "transport"})

    def test_no_write_operation_exists_on_connections(self) -> None:
        # `endpoints.json` still puts every connection write out of scope: they
        # are interactive studio flows (an OAuth round trip, a live credential
        # test), and half of one in an SDK is worse than none.
        #
        # Workflows used to be named here too. They are not any more: the write
        # half of that domain is a plain stateless POST/DELETE over an
        # already-resolved body — nothing interactive to conduct — so it left
        # `outOfScope` and became `workflows.create`/`update`/`archive`/`delete`
        # in the contract. Connections did NOT come with it, and this test is
        # what keeps that distinction from eroding by association.
        client = _client()

        for name in ("create", "update", "delete", "test"):
            with self.subTest(operation=name):
                self.assertFalse(hasattr(client.connections, name))


class BarrelTest(unittest.TestCase):
    """`__all__` is the promise; this is where it is kept."""

    def test_all_lists_exactly_the_public_surface(self) -> None:
        self.assertEqual(set(w6w.__all__), PUBLIC_SURFACE)

    def test_all_is_sorted_and_free_of_duplicates(self) -> None:
        # Sorted so a merge that adds two names in two branches conflicts
        # visibly rather than producing a duplicate nobody notices.
        self.assertEqual(w6w.__all__, sorted(set(w6w.__all__)))

    def test_every_promised_name_is_actually_importable(self) -> None:
        # A name in `__all__` that does not resolve makes `from w6w import *`
        # raise — and `__all__` is the only import path users are promised.
        for name in w6w.__all__:
            with self.subTest(name=name):
                self.assertTrue(hasattr(w6w, name), "w6w no longer exports {0}".format(name))

    def test_the_exported_classes_and_guards_are_usable_not_merely_present(self) -> None:
        # Names can survive as holes that are the wrong thing entirely; these
        # lines fail if a binding is not what it claims to be.
        client = _client()

        self.assertEqual(w6w.join_base_url("https://x.example.com/"), "https://x.example.com")
        self.assertEqual(w6w.path("/documents/{key}", key="a/b"), "/documents/a%2Fb")
        self.assertEqual(w6w.ApiError(404, "unknown_document", "No such.").status, 404)
        self.assertTrue(w6w.is_action_run({"kind": "action", "value": 1}))
        self.assertFalse(w6w.is_action_run({"kind": "batch"}))
        self.assertTrue(w6w.is_terminal_run_status("canceled"))
        self.assertFalse(w6w.is_terminal_run_status("running"))
        self.assertEqual(client.config.base_url, "https://api.example.com")

    def test_the_omit_sentinel_is_falsy_and_a_singleton(self) -> None:
        # Tested with `is`, never truthiness — `0`, `""` and `False` are all
        # legitimate values a caller may be patching in.
        self.assertIs(w6w.UNSET, w6w.Unset())
        self.assertFalse(bool(w6w.UNSET))
        self.assertEqual(repr(w6w.UNSET), "UNSET")


if __name__ == "__main__":  # pragma: no cover - convenience for a single-file run.
    unittest.main()
