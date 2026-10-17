import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
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
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let refresh = () => {};
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval: (callback: () => void) => { refresh = callback; return 1; }, clearInterval: () => {} },
  });
  let renderer: ReturnType<typeof create> | undefined;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
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
  await act(async () => { renderer = create(createElement(GPUAccelerationSettings, props)); });
  const toggle = () => renderer!.root.findByProps({ id: "generation-gpu-toggle" });
  const detail = () => renderer!.root.findByProps({ id: "generation-gpu-detail" });
  assert.equal(toggle().props["aria-checked"], false);
  await act(async () => toggle().props.onClick());
  assert.equal(requests[1].url, "/admin/api/generation/gpu/probe");
  assert.equal(toggle().props.disabled, true);
  assert.deepEqual(detail().children, ["检测中"]);
  assert.equal(toggle().props["aria-describedby"], "generation-gpu-detail");
  assert.deepEqual(changes, []);
  await act(async () => requests[1].resolve(Response.json({
    enabled: false, checked: true, available: false, reason: "缺少 GPU 设备", fallbackCount: 0,
  })));
  assert.deepEqual(changes, []);
  assert.deepEqual(errors, ["未检测到 GPU"]);
  assert.equal(toggle().props["aria-checked"], false);
  assert.equal(toggle().props.disabled, false);
  assert.deepEqual(detail().children, []);
  assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 0);
  assert.ok(!JSON.stringify(renderer!.toJSON()).includes("缺少 GPU 设备"));
  await act(async () => toggle().props.onClick());
  await act(async () => requests[2].resolve(Response.json({
    enabled: false, checked: true, available: true, backend: "cuda", device: "0",
    name: "NVIDIA GeForce RTX 4060 Laptop GPU", fallbackCount: 0,
  })));
  assert.deepEqual(changes, [true]);
  await act(async () => renderer!.update(createElement(GPUAccelerationSettings, {
    ...props, enabled: true,
  })));
  assert.deepEqual(detail().children, ["RTX 4060"]);
  assert.equal(detail().props.title, "NVIDIA GeForce RTX 4060 Laptop GPU");
  await act(async () => requests[0].resolve(Response.json({
    enabled: false, checked: true, available: false, reason: "过期的 GPU 检测错误", fallbackCount: 0,
  })));
  assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 0);
  assert.deepEqual(detail().children, ["RTX 4060"]);
  assert.deepEqual(errors, ["未检测到 GPU"]);
  await act(async () => renderer!.update(createElement(GPUAccelerationSettings, props)));
  assert.deepEqual(detail().children, []);
  assert.equal(detail().props.title, undefined);
  assert.equal(toggle().props["aria-describedby"], undefined);
  // A new parent callback is used when a slow probe finishes.
  const latestChanges: boolean[] = [];
  await act(async () => toggle().props.onClick());
  await act(async () => renderer!.update(createElement(GPUAccelerationSettings, {
    ...props, onChange: (enabled: boolean) => latestChanges.push(enabled),
  })));
  await act(async () => requests[3].resolve(Response.json({
    enabled: false, checked: true, available: true, backend: "vaapi",
    name: "Intel(R) Iris(R) Xe Graphics", fallbackCount: 0,
  })));
  assert.deepEqual(latestChanges, [true]);
  await act(async () => renderer!.update(createElement(GPUAccelerationSettings, {
    ...props, enabled: true,
  })));
  assert.deepEqual(detail().children, ["Iris Xe"]);
  await act(async () => toggle().props.onClick());
  assert.deepEqual(changes, [true, false]);
  assert.equal(requests.length, 4, "disabling does not probe hardware");
  await act(async () => renderer!.update(createElement(GPUAccelerationSettings, props)));
  assert.deepEqual(detail().children, []);
  await act(async () => toggle().props.onClick());
  await act(async () => requests[4].reject(new Error("GPU 检测服务不可用")));
  assert.deepEqual(errors, ["未检测到 GPU", "GPU 检测服务不可用"]);
  assert.equal(toggle().props["aria-checked"], false);
  assert.equal(toggle().props.disabled, false);
  assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 0);
  await act(async () => refresh());
  await act(async () => requests[5].reject(new Error("读取 GPU 状态失败")));
  assert.deepEqual(errors, ["未检测到 GPU", "GPU 检测服务不可用"]);
  await act(async () => renderer!.unmount());
  assert.equal(requests[0].signal.aborted, true);
});

test("GPU header restores compact model names from cached status", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setInterval: () => 1, clearInterval: () => {} },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
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
    [undefined, undefined],
  ]) {
    name = full;
    let renderer!: ReturnType<typeof create>;
    await act(async () => { renderer = create(createElement(GPUAccelerationSettings, {
      enabled: true, disabled: false, onChange: () => {}, onError: () => assert.fail("Reading status must not notify"),
    })); });
    const detail = renderer.root.findByProps({ id: "generation-gpu-detail" });
    assert.deepEqual(detail.children, compact ? [compact] : []);
    assert.equal(detail.props.title, full);
    await act(async () => renderer.update(createElement(GPUAccelerationSettings, {
      enabled: false, disabled: false, onChange: () => {}, onError: () => assert.fail("Disabling must not notify"),
    })));
    assert.deepEqual(detail.children, []);
    assert.equal(detail.props.title, undefined);
    assert.equal(renderer.root.findByProps({ id: "generation-gpu-toggle" }).props["aria-describedby"], undefined);
    await act(async () => renderer.unmount());
  }
});
