/**
 * `<W6WProvider>` + the C-4 token-supplier shim, plus one read hook and two
 * mutation hooks exercised end-to-end through it (A11) — every request goes
 * through a fake `fetch` injected via the `fetch` prop, mirroring the pattern
 * `node/tests/http_test.ts`/`client_test.ts` use for the SDK's own transport
 * tests (read-only reference, transcribed here, never imported). The
 * `useRunWorkflow` case (T1.1.2) pins its `wait: true` default — and that a
 * caller's explicit `wait: false` survives it — by reading the `?wait=`
 * query param on the wire, since that is the only externally observable
 * effect of what gets passed to `client.workflows.run`.
 *
 * Real React reconciliation (jsdom + `react-dom/client` + `act`) is used
 * deliberately for the memoization test below: it asserts the SAME
 * `W6WClient` reference survives a genuine RE-RENDER of the same component
 * instance, which `renderToStaticMarkup` (a fresh mount every call) cannot
 * exercise.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike, W6WClient } from "@w6w/sdk";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { W6WProvider, useW6WClient } from "../W6WProvider.tsx";
import { useCreateVar, useMe, useRunWorkflow } from "../hooks.ts";

// React 18.3+'s `act` warns ("not configured to support act(...)") unless this
// flag is set — required once per process, not per test.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** One recorded call to the fake transport. */
interface Call {
  url: string;
  headers: Headers;
}

/** A `fetch`-shaped fake. `respond` defaults to answering `200 {}`. */
function fakeFetch(respond?: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    const call: Call = { url: input, headers: new Headers(init?.headers) };
    calls.push(call);
    return Promise.resolve(
      respond
        ? respond(call)
        : new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fresh jsdom document + root per test, so no test leaks state into another. */
function withRoot<T>(run: (root: Root) => Promise<T> | T): Promise<T> {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  (globalThis as unknown as { window: unknown }).window = dom.window;
  (globalThis as unknown as { document: Document }).document = dom.window.document;
  // Node 24 already defines a getter-only `globalThis.navigator` (its own Web
  // API shim) — a plain assignment throws, so this needs a real property
  // redefinition to point react-dom at jsdom's `navigator` instead.
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  const container = dom.window.document.getElementById("root") as unknown as Element;
  const root = createRoot(container);
  return Promise.resolve(run(root)).finally(() => {
    act(() => {
      root.unmount();
    });
  });
}

test("token supplier is re-read per request, not captured at construction", () =>
  withRoot(async (root) => {
    const fake = fakeFetch();
    let n = 0;
    const tokenSupplier = () => (n++ === 0 ? "token-a" : "token-b");

    let captured: W6WClient | null = null;
    function Capture() {
      captured = useW6WClient();
      return null;
    }

    act(() => {
      root.render(
        createElement(
          W6WProvider,
          { baseUrl: "https://api.example.com", token: tokenSupplier, fetch: fake.fetch },
          createElement(Capture),
        ),
      );
    });
    assert.ok(captured, "useW6WClient did not resolve a client");
    const client = captured as W6WClient;

    await client.me();
    await client.me();

    assert.equal(fake.calls.length, 2, "expected exactly two requests");
    assert.equal(fake.calls[0]?.headers.get("authorization"), "Bearer token-a");
    assert.equal(fake.calls[1]?.headers.get("authorization"), "Bearer token-b");
  }));

test("the client is memoized across re-renders on baseUrl, not on token", () =>
  withRoot((root) => {
    const fake = fakeFetch();
    let captured: W6WClient | null = null;
    function Capture() {
      captured = useW6WClient();
      return null;
    }

    act(() => {
      root.render(
        createElement(
          W6WProvider,
          { baseUrl: "https://api.example.com", token: "token-a", fetch: fake.fetch },
          createElement(Capture),
        ),
      );
    });
    const first = captured;
    assert.ok(first, "first render did not capture a client");

    act(() => {
      root.render(
        createElement(
          W6WProvider,
          { baseUrl: "https://api.example.com", token: "token-b", fetch: fake.fetch },
          createElement(Capture),
        ),
      );
    });
    const second = captured;

    assert.equal(first, second, "the client must be the SAME reference across re-renders");
  }));

test("useW6WClient throws a helpful error outside <W6WProvider>", () =>
  withRoot((root) => {
    function Capture() {
      useW6WClient();
      return null;
    }
    assert.throws(() => {
      act(() => {
        root.render(createElement(Capture));
      });
    }, /useW6WClient must be used inside <W6WProvider>/);
  }));

test("useMe (read hook) fetches through the provider's client and resolves {data, loading}", () =>
  withRoot(async (root) => {
    const fake = fakeFetch(() =>
      json({ tenant: "t1", subject: "s1", account: "a1", role: "owner" }),
    );

    let captured: ReturnType<typeof useMe> | null = null;
    function Probe() {
      captured = useMe();
      return null;
    }

    await act(async () => {
      root.render(
        createElement(
          W6WProvider,
          { baseUrl: "https://api.example.com", token: "tok_1", fetch: fake.fetch },
          createElement(Probe),
        ),
      );
      // Let the fetch stub's promise (and the resulting state update) settle
      // while still inside this async `act` scope.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.ok(captured);
    const result = captured as ReturnType<typeof useMe>;
    assert.equal(result.loading, false);
    assert.equal(result.error, undefined);
    assert.equal(result.data?.tenant, "t1");
  }));

test("useCreateVar (mutation hook) calls through the provider's client and returns the created row", () =>
  withRoot(async (root) => {
    const fake = fakeFetch(() =>
      json(
        {
          var: {
            id: "var_1",
            name: "x",
            type: "string",
            value: "a",
            description: "",
            createdAt: "t",
            updatedAt: "t",
          },
        },
        201,
      ),
    );

    let captured: ReturnType<typeof useCreateVar> | null = null;
    function Probe() {
      captured = useCreateVar();
      return null;
    }

    act(() => {
      root.render(
        createElement(
          W6WProvider,
          { baseUrl: "https://api.example.com", token: "tok_1", fetch: fake.fetch },
          createElement(Probe),
        ),
      );
    });
    assert.ok(captured);

    let created: { id: string } | undefined;
    await act(async () => {
      created = await (captured as ReturnType<typeof useCreateVar>).call({
        name: "x",
        type: "string",
        value: "a",
      });
    });

    assert.equal(created?.id, "var_1");
    assert.equal(fake.calls.length, 1);
  }));

test("useRunWorkflow defaults to wait: true, but does not clobber an explicit wait: false", () =>
  withRoot(async (root) => {
    const fake = fakeFetch(() => json({ runId: "run_1", status: "succeeded" }));

    let captured: ReturnType<typeof useRunWorkflow> | null = null;
    function Probe() {
      captured = useRunWorkflow();
      return null;
    }

    act(() => {
      root.render(
        createElement(
          W6WProvider,
          { baseUrl: "https://api.example.com", token: "tok_1", fetch: fake.fetch },
          createElement(Probe),
        ),
      );
    });
    assert.ok(captured);
    const hook = captured as ReturnType<typeof useRunWorkflow>;

    // No options: the omitted `wait` must default to `true` — sent on the wire
    // as `?wait=true` (`node/src/workflows.ts` only ever emits `?wait=true` or
    // no `wait` param at all).
    await act(async () => {
      await hook.call("wf_1");
    });
    assert.equal(fake.calls.length, 1);
    assert.match(
      new URL(fake.calls[0]?.url as string).search,
      /(?:^\?|&)wait=true(?:&|$)/,
      "expected ?wait=true when the caller omits `wait`",
    );

    // Explicit `wait: false` must survive, not be overwritten by the default —
    // which shows up on the wire as NO `wait` param at all (the server treats
    // `?wait=false` the same as its absence, so the transport never sends it).
    await act(async () => {
      await hook.call("wf_1", { wait: false });
    });
    assert.equal(fake.calls.length, 2);
    assert.doesNotMatch(
      new URL(fake.calls[1]?.url as string).search,
      /wait=true/,
      "an explicit wait: false must not be clobbered into ?wait=true",
    );
  }));
