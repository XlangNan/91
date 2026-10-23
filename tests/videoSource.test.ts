import "./helpers/dom-environment.ts";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  attachVideoSource,
  disposeVideoSource,
  playbackSourceError,
  playbackSourceState,
  playbackSourceURL,
  retryVideoSource,
  selectPlaybackMode,
  useOriginalVideoSource,
  type PlaybackSource,
} from "../src/lib/videoSource.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const videos = new Set<HTMLVideoElement>();
afterEach(() => {
  for (const video of videos) disposeVideoSource(video);
  videos.clear();
  FakeHls.instances = [];
});
function media() {
  const video = document.createElement("video");
  videos.add(video);
  Object.defineProperties(video, {
    paused: { configurable: true, writable: true, value: true },
    error: { configurable: true, writable: true, value: null },
    readyState: { configurable: true, writable: true, value: 4 },
    videoWidth: { configurable: true, writable: true, value: 1080 },
    videoHeight: { configurable: true, writable: true, value: 1920 },
    duration: { configurable: true, writable: true, value: 180 },
  });
  video.canPlayType = (type) => type === "video/mp4" ? "probably" : "";
  video.load = () => {
    video.currentTime = 0;
    video.playbackRate = 1;
    Object.defineProperty(video, "error", { value: null, configurable: true, writable: true });
  };
  video.pause = () => {
    Object.defineProperty(video, "paused", { value: true, configurable: true, writable: true });
    video.dispatchEvent(new Event("pause"));
  };
  video.play = async () => {
    Object.defineProperty(video, "paused", { value: false, configurable: true, writable: true });
    video.dispatchEvent(new Event("play"));
  };
  return video;
}
const original: PlaybackSource = {
  id: "original", label: "原画播放", kind: "original", protocol: "file", status: "ready",
  url: "/p/stream/wo/file", mediaType: "video/mp4",
};
const cloud: PlaybackSource = {
  id: "cloud", label: "兼容播放", kind: "transcoded", protocol: "hls", status: "unknown",
  resolveUrl: "/api/video/one/playback?source=cloud",
};
const readyCloud: PlaybackSource = { ...cloud, status: "ready", url: "https://hls.example/index.m3u8" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "Content-Type": "application/json" },
});
const manifest = (...sources: PlaybackSource[]) => json({ sources });
class FakeHls {
  static instances: FakeHls[] = [];
  static isSupported() { return true; }
  static Events = { ERROR: "error" };
  handler!: (_event: string, data: { fatal: boolean; type?: string; response?: { code: number } }) => void;
  destroyed = false;
  url = "";
  constructor(public config: Record<string, unknown>) { FakeHls.instances.push(this); }
  on(_event: string, handler: FakeHls["handler"]) { this.handler = handler; }
  loadSource(url: string) { this.url = url; }
  attachMedia() {}
  destroy() { this.destroyed = true; }
  fail(type = "networkError", code?: number) { this.handler("error", { fatal: true, type, response: code ? { code } : undefined }); }
}
const loadHls = async () => FakeHls as never;
function setup(options: { original?: PlaybackSource; cloud?: PlaybackSource; mode?: "auto" | "original" | "compatible" } = {}) {
  const video = media();
  const urls: URL[] = [];
  const originalSource = options.original ?? original;
  const fetcher = (async (path: RequestInfo | URL) => {
    const url = new URL(String(path));
    urls.push(url);
    if (url.pathname.startsWith("/p/")) return new Response(null, { status: 206 });
    return manifest(originalSource, url.searchParams.get("source") === "cloud" ? options.cloud ?? readyCloud : cloud);
  }) as typeof fetch;
  attachVideoSource(video, original.url!, "/api/video/one/playback", { fetch: fetcher, loadHls, mode: options.mode });
  return { video, urls };
}
function mediaError(video: HTMLVideoElement, code = 4) {
  Object.defineProperty(video, "error", { value: { code }, configurable: true, writable: true });
  video.dispatchEvent(new Event("error"));
}

test("automatic original playback does not resolve or load the optional HLS source", async () => {
  const { video, urls } = setup();
  await settle();
  assert.equal(urls.length, 1);
  assert.equal(video.src, "http://localhost/p/stream/wo/file");
  assert.equal(FakeHls.instances.length, 0);
  assert.equal(playbackSourceState(video)?.activeSource?.id, "original");
  video.dispatchEvent(new Event("waiting"));
  video.dispatchEvent(new Event("stalled"));
  await settle();
  assert.equal(urls.length, 1);
});

test("play intent during asynchronous discovery survives source loading", async () => {
  const video = media();
  let finish!: (response: Response) => void;
  let plays = 0;
  video.addEventListener("play", () => plays++);
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    fetch: (() => new Promise((resolve) => { finish = resolve; })) as typeof fetch,
  });
  await video.play();
  finish(manifest(original));
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(plays, 2);
});

test("unsupported original containers select HLS without fetching raw media", async () => {
  const { video, urls } = setup({ original: { ...original, mediaType: "video/mp2t" } });
  await settle();
  assert.equal(video.getAttribute("src"), null);
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("source"), "cloud");
  assert.equal(FakeHls.instances[0].url, readyCloud.url);
});

test("audio-only decode failures switch to HLS without refreshing an incompatible original", async () => {
  const { video, urls } = setup();
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  await video.play();
  Object.defineProperties(video, { videoWidth: { value: 0 }, videoHeight: { value: 0 } });
  for (const time of [0, 4]) {
    video.currentTime = time;
    video.dispatchEvent(new Event("timeupdate"));
  }
  await settle();
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("refresh"), null);
  assert.equal(playbackSourceState(video)?.activeSource?.id, "cloud");
  assert.match(playbackSourceState(video)?.notice ?? "", /已切换兼容播放/);
});

test("manual original playback fails visibly without changing quality", async () => {
  const { video, urls } = setup({ mode: "original" });
  await settle();
  mediaError(video);
  await settle();
  assert.ok(playbackSourceError(video));
  assert.equal(FakeHls.instances.length, 0);
  assert.equal(urls.filter((url) => url.pathname.startsWith("/api/")).length, 1);
  assert.equal(playbackSourceState(video)?.mode, "original");
});

test("manual switches preserve progress, play intent, rate, volume and mute", async () => {
  const { video } = setup();
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  video.currentTime = 47;
  video.playbackRate = 1.5;
  video.volume = 0.35;
  video.muted = true;
  await video.play();
  selectPlaybackMode(video, "compatible");
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(video.currentTime, 47);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.volume, 0.35);
  assert.equal(video.muted, true);
  assert.equal(video.paused, false);
  assert.equal(playbackSourceState(video)?.mode, "compatible");
  assert.equal(playbackSourceURL(video), readyCloud.url);
  video.pause();
  selectPlaybackMode(video, "original");
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 47);
  assert.equal(FakeHls.instances[0].destroyed, true);
});

test("network recovery refreshes each source once and never cycles back to failed sources", async () => {
  const { video, urls } = setup();
  await settle();
  mediaError(video, 2);
  await settle();
  assert.equal(urls.filter((url) => url.searchParams.get("source") === "original").length, 1);
  mediaError(video, 2);
  await settle();
  assert.equal(playbackSourceState(video)?.activeSource?.id, "cloud");
  FakeHls.instances[0].fail("mediaError");
  await settle();
  assert.ok(playbackSourceError(video));
  assert.equal(urls.filter((url) => url.searchParams.get("source") === "original").length, 1);
});

test("signed HLS failures refresh once while manual compatibility remains pinned", async () => {
  const { video, urls } = setup({ mode: "compatible" });
  await settle();
  FakeHls.instances[0].fail("networkError", 403);
  await settle();
  assert.equal(FakeHls.instances[0].destroyed, true);
  assert.equal(urls.filter((url) => url.searchParams.get("refresh") === "1").length, 1);
  FakeHls.instances[1].fail("networkError", 403);
  await settle();
  assert.ok(playbackSourceError(video));
  assert.equal(playbackSourceState(video)?.mode, "compatible");
  assert.equal(video.getAttribute("src"), null);
});

test("HLS throttling stops without refresh or source rotation", async () => {
  const { video, urls } = setup({ mode: "compatible" });
  await settle();
  FakeHls.instances[0].fail("networkError", 429);
  await settle();
  assert.ok(playbackSourceError(video));
  assert.equal(urls.length, 2);
});

test("cloud processing stays separate from original availability and user retry resolves it again", async () => {
  const video = media();
  let ready = false;
  const urls: URL[] = [];
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    mode: "compatible", loadHls,
    fetch: (async (path) => {
      const url = new URL(String(path));
      urls.push(url);
      return manifest(original, url.searchParams.get("source") === "cloud"
        ? ready ? readyCloud : { ...cloud, status: "processing", message: "网盘正在转码" } : cloud);
    }) as typeof fetch,
  });
  await settle();
  assert.match(playbackSourceError(video)!, /正在转码/);
  assert.equal(video.getAttribute("src"), null);
  ready = true;
  retryVideoSource(video);
  await settle();
  assert.equal(playbackSourceState(video)?.mode, "compatible");
  assert.equal(playbackSourceError(video), null);
  assert.equal(FakeHls.instances.length, 1);
  assert.equal(urls.at(-1)?.searchParams.get("refresh"), "1");
});

test("changing mode cancels a pending cloud resolution and ignores its late result", async () => {
  const video = media();
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    loadHls,
    fetch: (async (path, init) => {
      if (String(path).includes("source=cloud")) {
        signal = init?.signal;
        return new Promise((resolve) => { finish = resolve; });
      }
      return manifest(original, cloud);
    }) as typeof fetch,
  });
  await settle();
  selectPlaybackMode(video, "compatible");
  await settle();
  selectPlaybackMode(video, "original");
  await settle();
  assert.equal(signal?.aborted, true);
  finish(manifest(original, readyCloud));
  await settle();
  assert.equal(playbackSourceState(video)?.activeSource?.id, "original");
  assert.equal(FakeHls.instances.length, 0);
});

test("reusing an iOS element aborts and ignores an earlier video's metadata", async () => {
  const video = media();
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  attachVideoSource(video, "old", "/api/video/old/playback", {
    fetch: ((_url, init) => {
      signal = init?.signal;
      return new Promise((resolve) => { finish = resolve; });
    }) as typeof fetch,
  });
  attachVideoSource(video, "new", "/api/video/new/playback", {
    fetch: (async () => manifest({ ...original, url: "https://cdn.example/new.mp4" })) as typeof fetch,
  });
  await settle();
  assert.equal(signal?.aborted, true);
  finish(manifest({ ...original, url: "https://cdn.example/old.mp4" }));
  await settle();
  assert.equal(video.src, "https://cdn.example/new.mp4");
});

for (const status of [401, 403, 404, 410, 429]) {
  test(`metadata HTTP ${status} stops without media loading or automatic retry`, async () => {
    const video = media();
    let requests = 0;
    attachVideoSource(video, original.url!, "/api/video/one/playback", {
      fetch: (async () => { requests++; return json({}, status); }) as typeof fetch,
    });
    await settle();
    assert.ok(playbackSourceError(video));
    assert.equal(requests, 1);
    assert.equal(video.getAttribute("src"), null);
  });
}

test("original media access failures stop instead of bypassing access through HLS", async () => {
  const video = media();
  let requests = 0;
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    fetch: (async (path) => {
      requests++;
      return String(path).includes("/p/stream/") ? json({}, 403) : manifest(original, cloud);
    }) as typeof fetch,
  });
  await settle();
  mediaError(video);
  await settle();
  assert.match(playbackSourceError(video)!, /无权/);
  assert.equal(requests, 2);
  assert.equal(FakeHls.instances.length, 0);
});

test("expired resolved links are refreshed before media loading", async () => {
  const video = media();
  const urls: URL[] = [];
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    mode: "compatible", loadHls,
    fetch: (async (path) => {
      const url = new URL(String(path));
      urls.push(url);
      return manifest(original, url.searchParams.has("refresh") ? readyCloud : { ...readyCloud, url: "https://hls.example/expired.m3u8", expiresAt: "2000-01-01T00:00:00Z" });
    }) as typeof fetch,
  });
  await settle();
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("refresh"), "1");
  assert.equal(FakeHls.instances[0].url, readyCloud.url);
});

test("a canvas delivery override selects original through the same controller", async () => {
  const { video } = setup({ mode: "compatible" });
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  video.currentTime = 33;
  assert.equal(useOriginalVideoSource(video, "/p/stream/wo/file?tripleScreenRelay=1"), true);
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(playbackSourceState(video)?.mode, "original");
  assert.match(video.src, /tripleScreenRelay=1/);
  assert.equal(video.currentTime, 33);
  assert.equal(FakeHls.instances[0].destroyed, true);
});

test("unknown-source manifests cannot silently play the raw URL", async () => {
  const video = media();
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    fetch: (async () => json({ sources: [{ ...original, protocol: "invalid" }] })) as typeof fetch,
  });
  await settle();
  assert.match(playbackSourceError(video)!, /无效数据/);
  assert.equal(video.getAttribute("src"), null);
});

test("the controller also supports a direct HLS source without a metadata endpoint", async () => {
  const video = media();
  attachVideoSource(video, readyCloud.url!, undefined, { loadHls });
  await settle();
  assert.equal(FakeHls.instances[0].url, readyCloud.url);
  disposeVideoSource(video);
  FakeHls.instances[0].fail();
  await settle();
  assert.equal(FakeHls.instances.length, 1);
});

test("provider rate limits wrapped in HTTP 502 stop original refresh and fallback", async () => {
  const video = media();
  let requests = 0;
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    fetch: (async (path) => {
      requests++;
      return String(path).includes("/p/stream/")
        ? json({ code: "drive_rate_limited", message: "网盘当前正在限流" }, 502)
        : manifest(original, cloud);
    }) as typeof fetch,
  });
  await settle();
  mediaError(video, 2);
  await settle();
  assert.match(playbackSourceError(video)!, /限流/);
  assert.equal(requests, 2);
});

test("volume changes during cloud resolution remain effective after switching", async () => {
  const video = media();
  let finish!: (response: Response) => void;
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    loadHls,
    fetch: (async (path) => String(path).includes("source=cloud")
      ? new Promise((resolve) => { finish = resolve; }) : manifest(original, cloud)) as typeof fetch,
  });
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  selectPlaybackMode(video, "compatible");
  await settle();
  video.volume = 0.2;
  video.muted = true;
  video.dispatchEvent(new Event("volumechange"));
  finish(manifest(original, readyCloud));
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(video.volume, 0.2);
  assert.equal(video.muted, true);
});

test("unavailable cloud playback records the failed source when the original format was skipped", async () => {
  const { video } = setup({
    original: { ...original, mediaType: "video/mp2t" },
    cloud: { ...cloud, status: "unavailable", message: "沃盘暂未提供该视频的兼容播放源" },
  });
  await settle();
  const error = playbackSourceState(video)?.error;
  assert.equal(error?.sourceID, "cloud");
  assert.equal(error?.reason, "unavailable");
  assert.deepEqual(error?.recoveryModes, []);
  assert.match(error?.message ?? "", /原画播放暂不可用；沃盘暂未提供/);
  assert.equal(playbackSourceState(video)?.notice, null);
});

test("reacquiring a failed cloud source preserves the failure of the original instead of cycling", async () => {
  const { video, urls } = setup({
    cloud: { ...cloud, status: "unavailable", message: "沃盘暂未提供该视频的兼容播放源" },
  });
  await settle();
  mediaError(video);
  await settle();
  const error = playbackSourceState(video)?.error;
  // The last attached source differs from the source whose resolution failed.
  assert.equal(playbackSourceState(video)?.activeSource?.id, "original");
  assert.equal(error?.sourceID, "cloud");
  assert.deepEqual(error?.recoveryModes, []);
  const previousCalls = urls.length;
  retryVideoSource(video);
  await settle();
  assert.equal(urls.length, previousCalls + 1);
  assert.equal(urls.at(-1)?.searchParams.get("source"), "cloud");
  assert.equal(urls.at(-1)?.searchParams.get("refresh"), "1");
  assert.equal(playbackSourceState(video)?.error?.sourceID, "cloud");
  assert.deepEqual(playbackSourceState(video)?.error?.recoveryModes, []);
});

test("reacquiring a missing cloud source can succeed while preserving smart selection", async () => {
  const video = media();
  let cloudReady = false;
  const urls: URL[] = [];
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    loadHls,
    fetch: (async (path) => {
      const url = new URL(String(path));
      urls.push(url);
      return manifest({ ...original, mediaType: "video/mp2t" }, url.searchParams.get("source") === "cloud"
        ? cloudReady ? readyCloud : { ...cloud, status: "unavailable", message: "沃盘暂未提供该视频的兼容播放源" } : cloud);
    }) as typeof fetch,
  });
  await settle();
  cloudReady = true;
  retryVideoSource(video);
  await settle();
  assert.equal(urls.at(-1)?.searchParams.get("source"), "cloud");
  assert.equal(urls.at(-1)?.searchParams.get("refresh"), "1");
  assert.equal(playbackSourceState(video)?.mode, "auto");
  assert.equal(playbackSourceState(video)?.activeSource?.id, "cloud");
  assert.equal(playbackSourceError(video), null);
});

test("manual compatibility failure offers original only when it is still playable", async () => {
  const { video } = setup({
    mode: "compatible", cloud: { ...cloud, status: "processing", message: "网盘正在转码" },
  });
  await settle();
  assert.equal(playbackSourceState(video)?.error?.sourceID, "cloud");
  assert.equal(playbackSourceState(video)?.error?.reason, "processing");
  assert.deepEqual(playbackSourceState(video)?.error?.recoveryModes, ["original"]);
  selectPlaybackMode(video, "original");
  await settle();
  assert.equal(playbackSourceError(video), null);
});

test("manual compatibility failure does not offer an unsupported original", async () => {
  const { video } = setup({
    mode: "compatible", original: { ...original, mediaType: "video/mp2t" },
    cloud: { ...cloud, status: "processing", message: "网盘正在转码" },
  });
  await settle();
  assert.deepEqual(playbackSourceState(video)?.error?.recoveryModes, []);
});

test("manual original decoding failure still offers an unresolved compatible source", async () => {
  const { video } = setup({ mode: "original" });
  await settle();
  mediaError(video);
  await settle();
  assert.equal(playbackSourceState(video)?.error?.sourceID, "original");
  assert.equal(playbackSourceState(video)?.error?.reason, "unsupported");
  assert.deepEqual(playbackSourceState(video)?.error?.recoveryModes, ["compatible"]);
});

test("retrying an unsupported original refreshes discovery instead of loading unsupported bytes", async () => {
  const video = media();
  const urls: URL[] = [];
  const unsupportedOriginal = { ...original, mediaType: "video/mp2t" };
  attachVideoSource(video, original.url!, "/api/video/one/playback", {
    loadHls,
    fetch: (async (path) => {
      const url = new URL(String(path));
      urls.push(url);
      return urls.length === 1 ? manifest(unsupportedOriginal)
        : manifest(unsupportedOriginal, url.searchParams.get("source") === "cloud" ? readyCloud : cloud);
    }) as typeof fetch,
  });
  await settle();
  assert.equal(playbackSourceState(video)?.error?.sourceID, "original");
  retryVideoSource(video);
  await settle();
  assert.equal(urls.length, 3);
  assert.equal(urls[1].searchParams.get("refresh"), "1");
  assert.equal(video.getAttribute("src"), null);
  assert.equal(playbackSourceState(video)?.activeSource?.id, "cloud");
});

test("an unsuccessful fallback never announces a successful source switch", async () => {
  const { video } = setup({ cloud: { ...cloud, status: "unavailable", message: "沃盘暂未提供该视频的兼容播放源" } });
  await settle();
  const notices: string[] = [];
  video.addEventListener("playback-source-change", () => {
    const notice = playbackSourceState(video)?.notice;
    if (notice) notices.push(notice);
  });
  mediaError(video);
  await settle();
  assert.ok(playbackSourceError(video));
  assert.deepEqual(notices, []);
});
