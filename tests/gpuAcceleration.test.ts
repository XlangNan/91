import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, fireEvent, render } from "./helpers/dom";
import { GPUAccelerationSettings } from "../src/admin/settings/GPUAccelerationSettings";
import { DEFAULT_DRAFT, applyVisualFields, changedVisualFields, parseConfig } from "../src/admin/settings/configYaml";

test("GPU is opt-in and round-trips through both YAML editor styles", () => {
  assert.equal(DEFAULT_DRAFT.useGPU, false);
  assert.equal(parseConfig("{}").draft.useGPU, false);
  for (const invalid of ["yes", '"true"', "1", "[]", "{}"] ) {
    assert.throws(() => parseConfig(`generation: { use_gpu: ${invalid} }`), /必须是布尔值/);
  }
  for (const source of [
    "# keep\ngeneration:\n  use_gpu: false # CPU default\n  preview_concurrency: 3\n",
    "generation: { use_gpu: false, preview_concurrency: 3 }\n",
    "generation:\r\n  use_gpu: false\r\n",
    "generation: null\n",
    "{}\n",
  ]) {
    const before = parseConfig(source).draft;
    const next = { ...before, useGPU: true };
    const fields = changedVisualFields(before, next);
    assert.deepEqual([...fields], ["useGPU"]);
    const updated = applyVisualFields(source, next, fields);
    assert.deepEqual(parseConfig(updated).draft, next);
    if (source.includes("use_gpu: false")) {
      assert.equal(updated, source.replace("use_gpu: false", "use_gpu: true"));
    }
  }
});

test("GPU switch verifies hardware before editing the draft and ignores an older status response", async (t) => {
  let refresh = () => {};
  t.mock.method(window, "setInterval", (callback: () => void) => { refresh = callback; return 1; });
  t.mock.method(window, "clearInterval", () => {});
  let renderer: ReturnType<typeof render> | undefined;
  t.after(async () => { await act(async () => renderer?.unmount()); });
  const requests: { url: string; signal: AbortSignal; resolve: (response: Response) => void; reject: (cause: Error) => void }[] = [];
  t.mock.method(globalThis, "fetch", (input, init) => new Promise<Response>((resolve, reject) => {
    requests.push({ url: String(input), signal: init!.signal as AbortSignal, resolve, reject });
  }));
  const changes: boolean[] = [];
  const errors: string[] = [];
  const props = {
    enabled: false, disabled: false,
    onChange: (enabled: boolean) => changes.push(enabled),
    onError: (message: string) => errors.push(message),
  };
  await act(async () => { renderer = render(createElement(GPUAccelerationSettings, props)); });
  const toggle = () => renderer!.container.querySelector<HTMLButtonElement>("#generation-gpu-toggle")!;
  const detail = () => renderer!.container.querySelector<HTMLElement>("#generation-gpu-detail")!;
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  await act(async () => fireEvent.click(toggle()));
  assert.equal(requests[1].url, "/admin/api/generation/gpu/probe");
  assert.equal(toggle().disabled, true);
  assert.deepEqual(detail().textContent, "检测中");
  assert.equal(toggle().getAttribute("aria-describedby"), "generation-gpu-detail");
  assert.deepEqual(changes, []);
  await act(async () => requests[1].resolve(Response.json({
    enabled: false, checked: true, available: false, reason: "缺少 GPU 设备", fallbackCount: 0,
  })));
  assert.deepEqual(changes, []);
  assert.deepEqual(errors, ["未检测到可用的加速硬件"]);
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  assert.equal(toggle().disabled, false);
  assert.equal(detail().textContent, "");
  assert.equal(renderer!.container.querySelectorAll('[role="alert"]').length, 0);
  assert.ok(!renderer!.container.textContent!.includes("缺少 GPU 设备"));
  await act(async () => fireEvent.click(toggle()));
  await act(async () => requests[2].resolve(Response.json({
    enabled: false, checked: true, available: true, backend: "cuda", device: "0",
    name: "NVIDIA GeForce RTX 4060 Laptop GPU", fallbackCount: 0,
  })));
  assert.deepEqual(changes, [true]);
  await act(async () => renderer!.rerender(createElement(GPUAccelerationSettings, {
    ...props, enabled: true,
  })));
  assert.deepEqual(detail().textContent, "RTX 4060");
  assert.equal(detail().getAttribute("title"), "NVIDIA GeForce RTX 4060 Laptop GPU");
  await act(async () => requests[0].resolve(Response.json({
    enabled: false, checked: true, available: false, reason: "过期的 GPU 检测错误", fallbackCount: 0,
  })));
  assert.equal(renderer!.container.querySelectorAll('[role="alert"]').length, 0);
  assert.deepEqual(detail().textContent, "RTX 4060");
  assert.deepEqual(errors, ["未检测到可用的加速硬件"]);
  await act(async () => renderer!.rerender(createElement(GPUAccelerationSettings, props)));
  assert.equal(detail().textContent, "");
  assert.equal(detail().getAttribute("title"), null);
  assert.equal(toggle().getAttribute("aria-describedby"), null);
  // A new parent callback is used when a slow probe finishes.
  const latestChanges: boolean[] = [];
  await act(async () => fireEvent.click(toggle()));
  await act(async () => renderer!.rerender(createElement(GPUAccelerationSettings, {
    ...props, onChange: (enabled: boolean) => latestChanges.push(enabled),
  })));
  await act(async () => requests[3].resolve(Response.json({
    enabled: false, checked: true, available: true, backend: "vaapi",
    name: "Intel(R) Iris(R) Xe Graphics", fallbackCount: 0,
  })));
  assert.deepEqual(latestChanges, [true]);
  await act(async () => renderer!.rerender(createElement(GPUAccelerationSettings, {
    ...props, enabled: true,
  })));
  assert.deepEqual(detail().textContent, "Iris Xe");
  await act(async () => fireEvent.click(toggle()));
  assert.deepEqual(changes, [true, false]);
  assert.equal(requests.length, 4, "disabling does not probe hardware");
  await act(async () => renderer!.rerender(createElement(GPUAccelerationSettings, props)));
  assert.equal(detail().textContent, "");
  await act(async () => fireEvent.click(toggle()));
  await act(async () => requests[4].reject(new Error("GPU 检测服务不可用")));
  assert.deepEqual(errors, ["未检测到可用的加速硬件", "GPU 检测服务不可用"]);
  assert.equal(toggle().getAttribute("aria-checked"), "false");
  assert.equal(toggle().disabled, false);
  assert.equal(renderer!.container.querySelectorAll('[role="alert"]').length, 0);
  await act(async () => refresh());
  await act(async () => requests[5].reject(new Error("读取 GPU 状态失败")));
  assert.deepEqual(errors, ["未检测到可用的加速硬件", "GPU 检测服务不可用"]);
  await act(async () => renderer!.unmount());
  assert.equal(requests[0].signal.aborted, true);
});

test("GPU header restores compact model names from cached status", async (t) => {
  t.mock.method(window, "setInterval", () => 1);
  t.mock.method(window, "clearInterval", () => {});
  let name: string | undefined;
  t.mock.method(globalThis, "fetch", async () => Response.json({
    enabled: true, checked: true, available: true, name, fallbackCount: 0,
  }));
  for (const [full, compact] of [
    ["AMD Radeon RX 7800 XT", "RX 7800 XT"],
    ["Intel Corporation DG2 [Arc A770]", "Arc A770"],
    ["NVIDIA RTX A4000", "RTX A4000"],
    ["NVIDIA GPU", "NVIDIA GPU"],
    ["Intel GPU", "Intel GPU"],
    ["Rockchip RK3588", "RK3588"],
    ["Rockchip VPU", "Rockchip VPU"],
    [undefined, undefined],
  ]) {
    name = full;
    let renderer!: ReturnType<typeof render>;
    await act(async () => { renderer = render(createElement(GPUAccelerationSettings, {
      enabled: true, disabled: false, onChange: () => {}, onError: () => assert.fail("Reading status must not notify"),
    })); });
    const detail = renderer.container.querySelector<HTMLElement>("#generation-gpu-detail")!;
    assert.deepEqual(detail.textContent, compact ?? "");
    assert.equal(detail.getAttribute("title"), full ?? null);
    await act(async () => renderer.rerender(createElement(GPUAccelerationSettings, {
      enabled: false, disabled: false, onChange: () => {}, onError: () => assert.fail("Disabling must not notify"),
    })));
    assert.equal(detail.textContent, "");
    assert.equal(detail.getAttribute("title"), null);
    assert.equal(renderer.container.querySelector("#generation-gpu-toggle")!.getAttribute("aria-describedby"), null);
    await act(async () => renderer.unmount());
  }
});
