import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { useShortsAudio } from "../src/shorts/useShortsAudio";

function setup(t: TestContext, saved?: string) {
  const values = new Map<string, string>();
  if (saved !== undefined) values.set("shorts:muted", saved);
  const writes: Array<[string, string]> = [];
  let storageBlocked = false;
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string) {
        if (storageBlocked) throw new Error("Storage unavailable");
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        if (storageBlocked) throw new Error("Storage unavailable");
        writes.push([key, value]);
        values.set(key, value);
      },
    },
  });
  let audio: ReturnType<typeof useShortsAudio>;
  function Probe() { audio = useShortsAudio(); return null; }
  let renderer: ReturnType<typeof create>;
  const mount = () => act(() => { renderer = create(createElement(Probe)); });
  mount();
  t.after(() => {
    act(() => renderer.unmount());
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return {
    get audio() { return audio; },
    writes,
    blockStorage() { storageBlocked = true; },
    remount() { act(() => renderer.unmount()); mount(); },
  };
}

function createVideo(play: (muted: boolean, attempt: number) => Promise<void> | void) {
  const attempts: boolean[] = [];
  const video = {
    muted: true,
    defaultMuted: true,
    play() {
      attempts.push(video.muted);
      return play(video.muted, attempts.length);
    },
  };
  return { video: video as unknown as HTMLVideoElement, attempts };
}

function deferred() {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
}

const notAllowed = () => new DOMException("Autoplay blocked", "NotAllowedError");

test("a fresh visit plays with sound when the browser allows it", async t => {
  const h = setup(t);
  const { video, attempts } = createVideo(() => Promise.resolve());
  assert.equal(h.audio.muted, false);
  await act(async () => h.audio.playWithAudioFallback(video, () => true));
  assert.deepEqual(attempts, [false]);
  assert.equal(video.defaultMuted, false);
  assert.equal(h.audio.muted, false);
  assert.deepEqual(h.writes, []);
});

test("policy rejection retries silently and keeps the next video muted", async t => {
  const h = setup(t);
  const { video, attempts } = createVideo(muted =>
    muted ? Promise.resolve() : Promise.reject(notAllowed()));
  await act(async () => h.audio.playWithAudioFallback(video, () => true));
  assert.deepEqual(attempts, [false, true]);
  assert.equal(h.audio.muted, true);
  assert.equal(video.defaultMuted, true);
  const next = createVideo(() => Promise.resolve());
  await act(async () => h.audio.playWithAudioFallback(next.video, () => true));
  assert.deepEqual(next.attempts, [true]);
  assert.deepEqual(h.writes, []);
  h.remount();
  assert.equal(h.audio.muted, false, "temporary fallback must not mute future visits");
});

test("explicit sound choices survive remounts and override temporary fallback", async t => {
  const h = setup(t);
  act(() => h.audio.setMuted(true));
  h.remount();
  const { video, attempts } = createVideo(() => Promise.resolve());
  await act(async () => h.audio.playWithAudioFallback(video, () => true));
  assert.deepEqual(attempts, [true]);
  act(() => h.audio.setMuted(false));
  h.remount();
  assert.equal(h.audio.muted, false);
  const blocked = createVideo(muted =>
    muted ? Promise.resolve() : Promise.reject(notAllowed()));
  await act(async () => h.audio.playWithAudioFallback(blocked.video, () => true));
  assert.equal(h.audio.muted, true);
  h.remount();
  assert.equal(h.audio.muted, false);
  assert.deepEqual(h.writes, [["shorts:muted", "true"], ["shorts:muted", "false"]]);
});

test("muted autoplay rejection is exposed after only one fallback", async t => {
  const h = setup(t);
  const failure = notAllowed();
  const { video, attempts } = createVideo(() => Promise.reject(failure));
  await act(async () => {
    await assert.rejects(h.audio.playWithAudioFallback(video, () => true), error => error === failure);
  });
  assert.deepEqual(attempts, [false, true]);
  assert.equal(h.audio.muted, true);
  const saved = createVideo(() => Promise.reject(failure));
  await act(async () => {
    await assert.rejects(h.audio.playWithAudioFallback(saved.video, () => true), error => error === failure);
  });
  assert.deepEqual(saved.attempts, [true]);
});

test("interrupted playback and media failures do not change the sound preference", async t => {
  const h = setup(t);
  for (const name of ["AbortError", "NotSupportedError"]) {
    const failure = new DOMException("Playback failed", name);
    const { video, attempts } = createVideo(() => Promise.reject(failure));
    await act(async () => {
      await assert.rejects(h.audio.playWithAudioFallback(video, () => true), error => error === failure);
    });
    assert.deepEqual(attempts, [false]);
    assert.equal(h.audio.muted, false);
  }
  assert.deepEqual(h.writes, []);
});

test("synchronous policy rejection also falls back to muted playback", async t => {
  const h = setup(t);
  const { video, attempts } = createVideo(muted => {
    if (!muted) throw notAllowed();
  });
  await act(async () => h.audio.playWithAudioFallback(video, () => true));
  assert.deepEqual(attempts, [false, true]);
  assert.equal(h.audio.muted, true);
});

test("leaving a slide or changing the shared source cancels its pending fallback", async t => {
  const h = setup(t);
  const pending = deferred();
  const { video, attempts } = createVideo(() => pending.promise);
  let currentSource = "first";
  const isCurrent = () => currentSource === "first";
  const request = h.audio.playWithAudioFallback(video, isCurrent);
  currentSource = "second";
  pending.reject(notAllowed());
  await act(async () => request);
  assert.deepEqual(attempts, [false]);
  assert.equal(h.audio.muted, false);
  await act(async () => h.audio.playWithAudioFallback(video, isCurrent));
  assert.deepEqual(attempts, [false], "an inactive slide must not start another play request");
});

test("a pending rejection cannot override a newer user sound choice", async t => {
  const h = setup(t);
  const pending = deferred();
  const { video, attempts } = createVideo(() => pending.promise);
  const request = h.audio.playWithAudioFallback(video, () => true);
  act(() => h.audio.setMuted(true));
  act(() => h.audio.setMuted(false));
  pending.reject(notAllowed());
  await act(async () => request);
  assert.deepEqual(attempts, [false]);
  assert.equal(h.audio.muted, false);
});

test("a failed muted retry cannot override a later unmute gesture", async t => {
  const h = setup(t);
  const pending = deferred();
  const { video } = createVideo(muted =>
    muted ? pending.promise : Promise.reject(notAllowed()));
  const request = h.audio.playWithAudioFallback(video, () => true);
  await act(async () => { await Promise.resolve(); });
  assert.equal(h.audio.muted, true);
  act(() => h.audio.setMuted(false));
  pending.reject(notAllowed());
  await act(async () => request);
  assert.equal(h.audio.muted, false);
});

test("unavailable or invalid storage still allows sound and temporary fallback", async t => {
  const h = setup(t, "invalid");
  assert.equal(h.audio.muted, false);
  h.blockStorage();
  h.remount();
  assert.equal(h.audio.muted, false);
  act(() => h.audio.setMuted(true));
  assert.equal(h.audio.muted, true);
  act(() => h.audio.setMuted(false));
  const { video } = createVideo(muted =>
    muted ? Promise.resolve() : Promise.reject(notAllowed()));
  await act(async () => h.audio.playWithAudioFallback(video, () => true));
  assert.equal(h.audio.muted, true);
});
