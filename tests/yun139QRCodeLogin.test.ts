import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { act, fireEvent, render } from "./helpers/dom";
import { ToastProvider } from "../src/components/ToastContext";
import { Yun139QRCodeLogin } from "../src/admin/drive/Yun139QRCodeLogin";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-10-23T12:00:00Z") });
  const reads: { sessionId: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }[] = [];
  let sequence = 0;
  const fetch = t.mock.method(globalThis, "fetch", async (input, init) => {
    assert.ok(String(input).includes("/drives/yun139/qr"));
    assert.equal(init!.method, "POST");
    if (String(input).endsWith("/status")) {
      const response = deferred<Response>();
      reads.push({ sessionId: JSON.parse(String(init!.body)).sessionId, signal: init!.signal as AbortSignal, response });
      return response.promise;
    }
    return Response.json({ sessionId: `session-${++sequence}`, qrImageDataUrl: "data:image/png;base64,test", expiresAt: new Date(Date.now() + 300_000).toISOString() });
  });
  let renderer: ReturnType<typeof render> | undefined;
  t.after(async () => { await act(async () => renderer?.unmount()); });
  const beginStart = () => { fireEvent.click(renderer!.container.querySelector("button.admin-btn")!); };
  return {
    reads, fetch, beginStart,
    get root() { return renderer!.container; },
    render: async (onAuthorization: (authorization: string) => void) => {
      const element = createElement(ToastProvider, null, createElement(Yun139QRCodeLogin, { onAuthorization }));
      await act(async () => {
        if (renderer) renderer.rerender(element);
        else renderer = render(element);
      });
    },
    start: async () => { await act(async () => { beginStart(); }); },
    tick: async (ms: number) => { await act(async () => t.mock.timers.tick(ms)); },
    unmount: async () => { await act(async () => renderer!.unmount()); },
  };
}

test("mobile QR login survives form rerenders and fills authorization through the latest callback", async (t) => {
  const env = harness(t);
  const authorizations: string[] = [];
  await env.render(() => assert.fail("stale callback received authorization"));
  await env.start();
  for (let i = 0; i < 5; i++) await env.render((authorization) => authorizations.push(authorization));
  await env.tick(60_000);
  assert.equal(env.reads.length, 1);
  assert.equal(env.reads[0].signal.aborted, false);
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "success", statusText: "登录成功", authorization: "new-authorization" })));
  assert.deepEqual(authorizations, ["new-authorization"]);
  await env.tick(300_000);
  assert.equal(env.reads.length, 1);
  assert.match(env.root.textContent!, /登录成功/);
  assert.doesNotMatch(env.root.textContent!, /已过期/);
});

test("mobile QR polling waits for each response, displays scan state and stops after cancellation", async (t) => {
  const env = harness(t);
  await env.render(() => assert.fail("canceled session returned authorization"));
  await env.start();
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "scanned", statusText: "已扫码，请在手机上确认登录" })));
  assert.match(env.root.textContent!, /请在手机上确认登录/);
  await env.tick(1999);
  assert.equal(env.reads.length, 1);
  await env.tick(1);
  assert.equal(env.reads.length, 2);
  await env.tick(10_000);
  assert.equal(env.reads.length, 2);
  await act(async () => env.reads[1].response.resolve(Response.json({ state: "canceled", statusText: "已取消登录，请重新生成二维码" })));
  await env.tick(300_000);
  assert.equal(env.reads.length, 2);
  assert.match(env.root.textContent!, /已取消登录/);
});

test("regenerating a mobile QR code aborts the previous session and ignores its late approval", async (t) => {
  const env = harness(t);
  const authorizations: string[] = [];
  await env.render((authorization) => authorizations.push(authorization));
  await env.start();
  await env.start();
  assert.equal(env.reads.length, 2);
  assert.equal(env.reads[0].signal.aborted, true);
  assert.notEqual(env.reads[0].sessionId, env.reads[1].sessionId);
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "success", authorization: "stale" })));
  assert.deepEqual(authorizations, []);
  await act(async () => env.reads[1].response.resolve(Response.json({ state: "success", statusText: "登录成功", authorization: "current" })));
  assert.deepEqual(authorizations, ["current"]);
});

test("mobile QR expiry aborts a stalled poll without accepting its late authorization", async (t) => {
  const env = harness(t);
  await env.render(() => assert.fail("expired session returned authorization"));
  await env.start();
  await env.tick(300_000);
  assert.equal(env.reads[0].signal.aborted, true);
  assert.match(env.root.textContent!, /二维码已过期/);
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "success", authorization: "late" })));
  await env.tick(4000);
  assert.equal(env.reads.length, 1);
});

test("closing mobile QR login aborts generation and polling", async (t) => {
  const env = harness(t);
  await env.render(() => assert.fail("closed session returned authorization"));
  await env.start();
  await env.unmount();
  assert.equal(env.reads[0].signal.aborted, true);
  await act(async () => env.reads[0].response.resolve(Response.json({ state: "success", authorization: "late" })));
  await env.tick(4000);
  assert.equal(env.reads.length, 1);
});

test("closing mobile QR login while generating cannot create a late poll", async (t) => {
  const env = harness(t);
  const generation = deferred<Response>();
  let signal!: AbortSignal;
  env.fetch.mock.mockImplementation(async (_input, init) => { signal = init!.signal as AbortSignal; return generation.promise; });
  await env.render(() => assert.fail("closed session returned authorization"));
  await act(async () => { env.beginStart(); });
  await env.unmount();
  assert.equal(signal.aborted, true);
  await act(async () => generation.resolve(Response.json({ sessionId: "late", expiresAt: new Date(Date.now() + 300_000).toISOString() })));
  assert.equal(env.fetch.mock.callCount(), 1);
});

test("mobile QR temporary errors retry the same session and successful responses require authorization", async (t) => {
  const env = harness(t);
  await env.render(() => assert.fail("incomplete login returned authorization"));
  await env.start();
  await act(async () => env.reads[0].response.resolve(new Response("<!DOCTYPE html>Bad Gateway", { status: 502 })));
  assert.match(env.root.textContent!, /HTTP 502/);
  assert.doesNotMatch(env.root.textContent!, /<!DOCTYPE/);
  await env.tick(2000);
  assert.equal(env.reads[0].sessionId, env.reads[1].sessionId);
  await act(async () => env.reads[1].response.resolve(Response.json({ state: "success", statusText: "登录成功" })));
  assert.match(env.root.textContent!, /未获取到授权/);
  await env.tick(4000);
  assert.equal(env.reads.length, 2);
});
