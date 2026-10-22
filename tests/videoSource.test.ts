import "./helpers/dom-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  attachVideoSource,
  disposeVideoSource,
  playbackSourceError,
  retryVideoSource,
} from "../src/lib/videoSource.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function media() {
  const video = document.createElement("video");
  Object.defineProperties(video, {
    paused: { configurable: true, writable: true, value: true },
    readyState: { configurable: true, writable: true, value: 4 },
    videoWidth: { configurable: true, writable: true, value: 1080 },
    videoHeight: { configurable: true, writable: true, value: 1920 },
  });
  video.load = () => {};
  video.pause = () => {
    Object.defineProperty(video, "paused", {
      value: true,
      configurable: true,
      writable: true,
    });
  };
  video.play = async () => {
    Object.defineProperty(video, "paused", {
      value: false,
      configurable: true,
      writable: true,
    });
    video.dispatchEvent(new Event("play"));
  };
  return video;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("play intent while resolving a source survives the asynchronous load", async () => {
  const video = media();
  let finish!: (response: Response) => void;
  let plays = 0;
  video.addEventListener("play", () => plays++);
  attachVideoSource(video, "source", "/api/video/one/playback", {
    fetch: (() =>
      new Promise((resolve) => {
        finish = resolve;
      })) as typeof fetch,
  });
  await video.play();
  finish(json({ type: "native", url: "https://cdn.example/video.mp4" }));
  await settle();
  video.dispatchEvent(new Event("loadedmetadata"));
  assert.equal(plays, 2);
  disposeVideoSource(video);
});

test("unavailable TS never requests raw media; user retry refreshes metadata", async () => {
  const video = media(),
    urls: string[] = [];
  const fetcher = async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return json(
      urls.length === 1
        ? { type: "unavailable", message: "网盘暂未提供 HLS" }
        : { type: "native", url: "https://cdn.example/video.mp4" },
    );
  };
  attachVideoSource(video, "/p/stream/wo/file", "/api/video/one/playback", {
    fetch: fetcher as typeof fetch,
  });
  await settle();
  assert.match(playbackSourceError(video)!, /暂未提供 HLS/);
  assert.equal(video.getAttribute("src"), null);
  assert.equal(urls.length, 1);
  retryVideoSource(video);
  await settle();
  assert.match(urls[1], /refresh=1/);
  assert.equal(video.src, "https://cdn.example/video.mp4");
  disposeVideoSource(video);
});

test("switching a persistent element aborts and ignores a late old resolution", async () => {
  const video = media();
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  attachVideoSource(video, "old", "/api/video/old/playback", {
    fetch: ((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }) as typeof fetch,
  });
  attachVideoSource(video, "new", "/api/video/new/playback", {
    fetch: (async () =>
      json({
        type: "native",
        url: "https://cdn.example/new.mp4",
      })) as typeof fetch,
  });
  await settle();
  assert.equal(signal?.aborted, true);
  finish(json({ type: "native", url: "https://cdn.example/old.mp4" }));
  await settle();
  assert.equal(video.src, "https://cdn.example/new.mp4");
  disposeVideoSource(video);
});

test("fatal HLS failures refresh once, then use explicit MP4 fallback", async () => {
  const video = media();
  const instances: FakeHls[] = [];
  class FakeHls {
    static isSupported() {
      return true;
    }
    static Events = { ERROR: "error" };
    handler!: (_event: string, data: { fatal: boolean }) => void;
    destroyed = false;
    constructor() {
      instances.push(this);
    }
    on(_event: string, handler: FakeHls["handler"]) {
      this.handler = handler;
    }
    loadSource() {}
    attachMedia() {}
    destroy() {
      this.destroyed = true;
    }
  }
  let requests = 0;
  attachVideoSource(video, "source", "/api/video/one/playback", {
    fetch: (async () => {
      requests++;
      return json({
        type: "hls",
        url: "https://hls.example/index.m3u8",
        fallback: { type: "native", url: "https://cdn.example/fallback.mp4" },
      });
    }) as typeof fetch,
    loadHls: async () => FakeHls as never,
  });
  await settle();
  instances[0].handler("error", { fatal: true });
  await settle();
  assert.equal(requests, 2);
  assert.equal(instances[0].destroyed, true);
  instances[1].handler("error", { fatal: true });
  await settle();
  assert.equal(video.src, "https://cdn.example/fallback.mp4");
  video.dispatchEvent(new Event("error"));
  await settle();
  assert.equal(requests, 2);
  assert.ok(playbackSourceError(video));
  disposeVideoSource(video);
});

test("audio progress without video dimensions reports codec failure after one refresh", async () => {
  const video = media();
  Object.defineProperties(video, {
    paused: { value: false, writable: true },
    videoWidth: { value: 0 },
    videoHeight: { value: 0 },
  });
  let requests = 0;
  attachVideoSource(video, "source", "/api/video/one/playback", {
    fetch: (async () => {
      requests++;
      return json({ type: "native", url: "https://cdn.example/hevc.mp4" });
    }) as typeof fetch,
  });
  await settle();
  for (const time of [0, 4]) {
    video.currentTime = time;
    video.dispatchEvent(new Event("timeupdate"));
  }
  await settle();
  for (const time of [0, 4]) {
    video.currentTime = time;
    video.dispatchEvent(new Event("timeupdate"));
  }
  await settle();
  assert.equal(requests, 2);
  assert.match(playbackSourceError(video)!, /未能解码视频画面/);
  disposeVideoSource(video);
});

test("authentication errors are shown without media requests or automatic retry", async () => {
  const video = media();
  let requests = 0;
  attachVideoSource(video, "source", "/api/video/one/playback", {
    fetch: (async () => {
      requests++;
      return json({}, 401);
    }) as typeof fetch,
  });
  await settle();
  assert.match(playbackSourceError(video)!, /登录状态已失效/);
  assert.equal(requests, 1);
  assert.equal(video.getAttribute("src"), null);
  disposeVideoSource(video);
});
