import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { act, fireEvent, render } from "./helpers/dom";
import { ToastProvider } from "../src/components/ToastContext";
import { SkipDirsPanel } from "../src/admin/drive/SkipDirsPanel";
import { useDriveDetailData } from "../src/admin/drive/useDriveDetailData";
import type { DriveConfig, DriveDirEntry, DriveSnapshot } from "../src/admin/api";

const config: DriveConfig = {
  id: "drive", kind: "quark", name: "Drive", rootId: "0", status: "ok",
  hasCredential: true, canUpload: true, skipDirIds: ["kept"], directoryRevision: 0,
};

async function mount(t: TestContext, directory: (url: URL, signal: AbortSignal) => Promise<Response>) {
  class TestStream {
    addEventListener() {}
    close() {}
  }
  const originalStream = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: TestStream });
  const savedSelections: string[][] = [];
  let renderer: ReturnType<typeof render> | undefined;
  t.after(async () => {
    await act(async () => renderer?.unmount());
    if (originalStream) Object.defineProperty(globalThis, "EventSource", originalStream);
    else Reflect.deleteProperty(globalThis, "EventSource");
  });
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/dirtree")) return directory(url, init!.signal as AbortSignal);
    if (url.pathname.endsWith("/skip-dirs")) {
      const { dirIds } = JSON.parse(String(init!.body));
      savedSelections.push(dirIds);
      return Response.json({ ok: true, skipDirIds: dirIds });
    }
    const resource = url.pathname.split("/").at(-1)!;
    return Response.json({ driveId: "drive", epoch: "server", resource, revision: 1, updatedAt: "now",
      data: resource === "config" ? config : {} });
  });
  let detail!: ReturnType<typeof useDriveDetailData>;
  function Probe() {
    detail = useDriveDetailData("drive", true);
    if (!detail.drive) return null;
    return createElement(SkipDirsPanel, {
      drive: detail.drive, directoryVersion: detail.directoryVersion,
      onSaved: (saved) => detail.accept(saved.snapshot),
    });
  }
  await act(async () => { renderer = render(createElement(ToastProvider, null, createElement(Probe))); });
  let revision = 1;
  return {
    root: renderer!.container,
    savedSelections,
    publish: async (directoryRevision: number, next: Partial<DriveConfig> = {}, epoch = "server") => {
      const snapshot: DriveSnapshot<"config"> = { driveId: "drive", resource: "config", epoch,
        revision: ++revision, updatedAt: "now", data: { ...config, ...next, directoryRevision } };
      await act(async () => detail.accept(snapshot));
    },
  };
}

test("credential application automatically retries failed directories and clears the old error", async (t) => {
  let reads = 0;
  const view = await mount(t, async () => {
    reads++;
    return reads === 1
      ? Response.json({ error: "Expired credentials" }, { status: 502 })
      : Response.json([{ id: "kept", name: "Recovered directory" }]);
  });
  assert.match(view.root.textContent!, /Expired credentials/);
  assert.equal(view.root.querySelector(".admin-skipdirs-retry")?.textContent, "重试");
  await view.publish(0, { name: "Saved credentials", status: "ok" });
  assert.equal(reads, 1, "saving desired config cannot reload before runtime application");
  await view.publish(8);
  assert.equal(reads, 2);
  assert.match(view.root.textContent!, /Recovered directory/);
  assert.doesNotMatch(view.root.textContent!, /Expired credentials/);
  assert.equal(view.root.querySelector(".admin-skipdirs-retry"), null);
  assert.equal(view.root.querySelector('[aria-label="取消隐藏目录 Recovered directory"]')?.getAttribute("aria-pressed"), "true");
  await view.publish(8, { skipDirIds: [] });
  assert.equal(reads, 2, "skip-directory saves and routine snapshots cannot invalidate directory reads");
});

test("runtime changes discard directory caches while preserving the current skip-directory draft", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let account = "Old";
  const reads: string[] = [];
  const view = await mount(t, async (url) => {
    const parent = url.searchParams.get("parent") || "root";
    reads.push(parent);
    const children: DriveDirEntry[] = parent === "root"
      ? [{ id: "kept", name: `${account} folder` }]
      : [{ id: "child", name: `${account} child` }];
    return Response.json(children);
  });
  await act(async () => fireEvent.click(view.root.querySelector('[aria-label="展开目录 Old folder"]')!));
  assert.match(view.root.textContent!, /Old child/);
  await act(async () => fireEvent.click(view.root.querySelector('[aria-label="隐藏目录 Old child"]')!));
  account = "New";
  await view.publish(9);
  assert.deepEqual(reads, ["root", "kept", "root"]);
  assert.doesNotMatch(view.root.textContent!, /Old/);
  await act(async () => fireEvent.click(view.root.querySelector('[aria-label="展开目录 New folder"]')!));
  assert.deepEqual(reads, ["root", "kept", "root", "kept"]);
  assert.equal(view.root.querySelector('[aria-label="取消隐藏目录 New child"]')?.getAttribute("aria-pressed"), "true");
  assert.equal(view.root.querySelector('[aria-label="取消隐藏目录 New folder"]')?.getAttribute("aria-pressed"), "true");
  await act(async () => t.mock.timers.tick(300));
  assert.deepEqual(view.savedSelections, [["child", "kept"]]);
});

test("a runtime change cancels old directory reads and ignores their late responses", async (t) => {
  const pending: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const view = await mount(t, async (_url, signal) => new Promise<Response>((resolve) => pending.push({ signal, resolve })));
  await view.publish(10);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  await act(async () => pending[1].resolve(Response.json([{ id: "new", name: "New account directory" }])));
  await act(async () => pending[0].resolve(Response.json([{ id: "old", name: "Old account directory" }])));
  assert.match(view.root.textContent!, /New account directory/);
  assert.doesNotMatch(view.root.textContent!, /Old account directory/);
});

test("a server restart invalidates directories even when its directory revision is unchanged", async (t) => {
  let reads = 0;
  const view = await mount(t, async () => { reads++; return Response.json([]); });
  await view.publish(0, {}, "replacement-server");
  assert.equal(reads, 2);
});
