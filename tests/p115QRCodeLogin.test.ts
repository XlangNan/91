import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { ToastProvider } from "../src/components/ToastContext";
import { P115QRCodeLogin } from "../src/admin/drive/P115QRCodeLogin";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originals = ["window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout, clearTimeout, matchMedia: () => ({ matches: true }),
  } });
  // React's test renderer stores portal children in this container.
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: { nodeType: 1, children: [] } } });
  const reads: { uid: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }[] = [];
  let sequence = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).endsWith("/status")) {
      const response = deferred<Response>();
      reads.push({ uid: JSON.parse(String(init!.body)).uid, signal: init!.signal as AbortSignal, response });
      return response.promise;
    }
    return Response.json({ uid: `session-${++sequence}`, time: 1, sign: "test-sign", qrImageDataUrl: "data:image/png;base64,test" });
  });
  let renderer: ReturnType<typeof create> | undefined;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const beginStart = () => renderer!.root.findByProps({ className: "admin-btn" }).props.onClick() as Promise<void>;
  return {
    reads, fetch, beginStart,
    get root() { return renderer!.root; },
    render: async (onCookie: (cookie: string) => void) => {
      const element = createElement(ToastProvider, null, createElement(P115QRCodeLogin, { onCookie }));
      await act(async () => {
        if (renderer) renderer.update(element);
        else renderer = create(element);
      });
    },
    start: async () => { await act(async () => { await beginStart(); }); },
    tick: async (ms: number) => { await act(async () => t.mock.timers.tick(ms)); },
    unmount: async () => { await act(async () => renderer!.unmount()); },
  };
}

test("115 QR login keeps one pending poll across parent rerenders and delivers its cookie to the latest callback", async (t) => {
  const env = harness(t);
  const cookies: string[] = [];
  await env.render(() => assert.fail("A stale callback received the cookie"));
  await env.start();
  for (let i = 0; i < 5; i++) await env.render((cookie) => cookies.push(cookie));
  await env.tick(60_000);
  assert.equal(env.reads.length, 1);
  assert.equal(env.reads[0].signal.aborted, false);
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "success", status: 2, cookie: "new-cookie" })));
  assert.deepEqual(cookies, ["new-cookie"]);
  await env.tick(2000);
  assert.equal(env.reads.length, 1);
});

test("115 QR polling waits for each response and stops after a terminal state", async (t) => {
  const env = harness(t);
  await env.render(() => assert.fail("A canceled QR session returned a cookie"));
  await env.start();
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "waiting", status: 0 })));
  await env.tick(1999);
  assert.equal(env.reads.length, 1);
  await env.tick(1);
  assert.equal(env.reads.length, 2);
  await env.tick(10_000);
  assert.equal(env.reads.length, 2);
  await act(async () => env.reads[1].response.resolve(Response.json({ state: "canceled", status: -2 })));
  await env.tick(10_000);
  assert.equal(env.reads.length, 2);
});

test("regenerating a 115 QR code cancels the old request and ignores its late successful response", async (t) => {
  const env = harness(t);
  const cookies: string[] = [];
  await env.render((cookie) => cookies.push(cookie));
  await env.start();
  await env.start();
  assert.equal(env.reads.length, 2);
  assert.equal(env.reads[0].signal.aborted, true);
  assert.equal(env.reads[1].signal.aborted, false);
  assert.notEqual(env.reads[0].uid, env.reads[1].uid);
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "success", status: 2, cookie: "stale-cookie" })));
  assert.deepEqual(cookies, []);
  await act(async () => env.reads[1].response.resolve(Response.json({ state: "success", status: 2, cookie: "current-cookie" })));
  assert.deepEqual(cookies, ["current-cookie"]);
});

test("115 QR login shows a concise gateway error and retries the same session", async (t) => {
  const env = harness(t);
  const cookies: string[] = [];
  await env.render((cookie) => cookies.push(cookie));
  await env.start();
  await act(async () => env.reads[0].response.resolve(new Response("<!DOCTYPE html><html>Bad gateway</html>", {
    status: 502, headers: { "Content-Type": "text/html" },
  })));
  assert.equal(env.root.findByProps({ className: "admin-form__help" }).children.join(""), "网站服务暂时不可用（HTTP 502），请稍后重试");
  await env.tick(2000);
  assert.equal(env.reads.length, 2);
  assert.equal(env.reads[0].uid, env.reads[1].uid);
  await act(async () => env.reads[1].response.resolve(Response.json({ state: "success", status: 2, cookie: "recovered-cookie" })));
  assert.deepEqual(cookies, ["recovered-cookie"]);
  assert.equal(env.root.findAllByProps({ className: "admin-form__help" }).length, 0);
});

test("closing 115 QR login cancels its pending poll", async (t) => {
  const env = harness(t);
  await env.render(() => assert.fail("A closed QR login returned a cookie"));
  await env.start();
  await env.unmount();
  assert.equal(env.reads[0].signal.aborted, true);
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "success", status: 2, cookie: "late-cookie" })));
  await env.tick(10_000);
  assert.equal(env.reads.length, 1);
});

test("closing 115 QR login cancels generation and prevents a late session from starting polls", async (t) => {
  const env = harness(t);
  const generation = deferred<Response>();
  let signal!: AbortSignal;
  env.fetch.mock.mockImplementation(async (_input, init) => { signal = init!.signal as AbortSignal; return generation.promise; });
  await env.render(() => assert.fail("A closed QR login returned a cookie"));
  let starting!: Promise<void>;
  await act(async () => { starting = env.beginStart(); });
  await env.unmount();
  assert.equal(signal.aborted, true);
  await act(async () => {
    generation.resolve(Response.json({ uid: "late", time: 1, sign: "test-sign" }));
    await starting;
  });
  assert.equal(env.fetch.mock.callCount(), 1);
});
