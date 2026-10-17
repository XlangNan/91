import assert from "node:assert/strict";
import test from "node:test";
import { APIResponseError, UnauthorizedError, getP115QRStatus } from "../src/admin/api";

const session = { uid: "test-uid", time: 1, sign: "test-sign" };
const html = '<!DOCTYPE html><!-- gateway --><html><head><title>502: Bad gateway</title></head><body>Host Error</body></html>';

test("admin API turns gateway HTML into a concise HTTP error", async (t) => {
  for (const response of [
    new Response(html, { status: 502, headers: { "Content-Type": "text/html" } }),
    new Response(html, { status: 502 }),
    Response.json({ error: html }, { status: 502 }),
  ]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(getP115QRStatus(session), (error) => {
      assert.ok(error instanceof APIResponseError);
      assert.equal(error.status, 502);
      assert.equal(error.message, "网站服务暂时不可用（HTTP 502），请稍后重试");
      assert.doesNotMatch(error.message, /<!DOCTYPE|<html|Host Error/);
      return true;
    });
    fetch.mock.restore();
  }
});

test("admin API preserves structured errors and plain-text messages", async (t) => {
  const body = { error: "二维码已过期", state: "expired" };
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(body, { status: 409 }));
  await assert.rejects(getP115QRStatus(session), (error) => {
    assert.ok(error instanceof APIResponseError);
    assert.equal(error.message, body.error);
    assert.deepEqual(error.body, body);
    return true;
  });
  fetch.mock.mockImplementation(async () => new Response("upstream connection refused", { status: 502 }));
  await assert.rejects(getP115QRStatus(session), /upstream connection refused/);
  fetch.mock.mockImplementation(async () => new Response(html, { status: 401, headers: { "Content-Type": "text/html" } }));
  await assert.rejects(getP115QRStatus(session), UnauthorizedError);
});
