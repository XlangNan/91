import type Hls from "hls.js";
import { diagnosePlaybackSource } from "./playbackError";

export type PlaybackSource = {
  type: "native" | "hls" | "unavailable";
  url?: string;
  mediaType?: string;
  message?: string;
  fallback?: PlaybackSource;
};

export const PLAYBACK_SOURCE_ERROR = "playback-source-error";
export const PLAYBACK_SOURCE_READY = "playback-source-ready";
type SourceOptions = {
  refresh?: boolean;
  loadNative?: (url: string) => void;
  fetch?: typeof fetch;
  loadHls?: () => Promise<typeof Hls>;
};
type SourceController = {
  key: string;
  error: string | null;
  url: string;
  readonly loading: boolean;
  retry(): void;
  destroy(): void;
};
const controllers = new WeakMap<HTMLVideoElement, SourceController>();

export function playbackSourceError(video: HTMLVideoElement) {
  return controllers.get(video)?.error ?? null;
}
export function videoSourceLoading(video: HTMLVideoElement) {
  return controllers.get(video)?.loading ?? false;
}
export function playbackSourceURL(video: HTMLVideoElement) {
  return controllers.get(video)?.url ?? video.currentSrc;
}
export function disposeVideoSource(video: HTMLVideoElement) {
  controllers.get(video)?.destroy();
  controllers.delete(video);
}
export function retryVideoSource(video: HTMLVideoElement) {
  const controller = controllers.get(video);
  if (!controller) return false;
  controller.retry();
  return true;
}

/** Owns one media element's source, including persistent iOS shorts elements. */
export function attachVideoSource(
  video: HTMLVideoElement,
  src: string,
  playbackUrl?: string,
  options: SourceOptions = {},
) {
  const key = `${src}\n${playbackUrl ?? ""}`;
  if (controllers.get(video)?.key === key) return;
  const replacing = controllers.has(video);
  disposeVideoSource(video);
  if (replacing) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  let disposed = false;
  let loading = false;
  let generation = 0;
  let abort: AbortController | null = null;
  let hls: Hls | null = null;
  let current: PlaybackSource | null = null;
  let refreshed = false;
  let usedFallback = false;
  let restore: { time: number; playing: boolean; rate: number } | null = null;
  let frameStart: number | null = null;
  let firstLoad = true;
  let wasPlaying = false;
  const controller: SourceController = {
    key,
    error: null,
    url: src,
    get loading() {
      return loading;
    },
    retry() {
      refreshed = false;
      usedFallback = false;
      void resolve(true);
    },
    destroy() {
      disposed = true;
      generation++;
      abort?.abort();
      hls?.destroy();
      hls = null;
      video.removeEventListener("error", mediaFailed);
      video.removeEventListener("loadedmetadata", loaded);
      video.removeEventListener("timeupdate", checkFrames);
      video.removeEventListener("playing", rememberPlaying);
      video.removeEventListener("play", rememberPlaying);
      video.removeEventListener("pause", rememberPause);
    },
  };
  controllers.set(video, controller);
  video.setAttribute("referrerpolicy", "no-referrer");
  video.addEventListener("error", mediaFailed);
  video.addEventListener("loadedmetadata", loaded);
  video.addEventListener("timeupdate", checkFrames);
  video.addEventListener("playing", rememberPlaying);
  video.addEventListener("play", rememberPlaying);
  video.addEventListener("pause", rememberPause);

  function rememberPlaying() {
    wasPlaying = true;
    if (hls) hls.config.maxBufferLength = 15;
  }
  function rememberPause() {
    if (!loading && !video.error && !controller.error) wasPlaying = false;
  }

  function fail(message: string) {
    if (disposed) return;
    controller.error = message;
    video.pause();
    video.dispatchEvent(new CustomEvent(PLAYBACK_SOURCE_ERROR));
  }
  function loaded() {
    if (disposed || !restore) return;
    const state = restore;
    restore = null;
    video.playbackRate = state.rate;
    if (state.time > 0 && Number.isFinite(video.duration)) {
      try {
        video.currentTime = Math.min(
          state.time,
          Math.max(0, video.duration - 0.1),
        );
      } catch {
        /* media not seekable yet */
      }
    }
    if (state.playing || wasPlaying) void video.play().catch(() => undefined);
  }
  function checkFrames() {
    if (disposed || loading || controller.error || video.paused) return;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      frameStart = null;
      return;
    }
    // Advancing audio with ready media but no video dimensions is the HEVC
    // audio-only failure observed in Chromium. Wall-clock buffering is excluded.
    if (video.readyState < 3) return;
    if (frameStart === null) frameStart = video.currentTime;
    if (video.currentTime - frameStart < 3) return;
    void recover(
      "当前浏览器未能解码视频画面，可能不支持原视频编码；可尝试支持该编码的浏览器，或稍后重新获取网盘 HLS 播放源",
    );
  }
  function mediaFailed() {
    if (disposed || loading || controller.error) return;
    void recover("视频源加载失败，请重试或换用兼容的浏览器");
  }
  async function recover(message: string) {
    if (disposed || loading) return;
    if (playbackUrl && !refreshed) {
      refreshed = true;
      await resolve(true);
      return;
    }
    if (current?.fallback && !usedFallback) {
      usedFallback = true;
      loading = true;
      frameStart = null;
      restore = {
        time: video.currentTime || 0,
        playing: wasPlaying || !video.paused,
        rate: video.playbackRate || 1,
      };
      await load(current.fallback, ++generation);
      return;
    }
    if (!playbackUrl) {
      const epoch = generation;
      const diagnostic = await diagnosePlaybackSource(src);
      if (disposed || epoch !== generation) return;
      message = diagnostic || message;
    }
    fail(message);
  }
  async function resolve(refresh: boolean) {
    if (disposed) return;
    const epoch = ++generation;
    loading = true;
    controller.error = null;
    frameStart = null;
    restore = {
      time: firstLoad ? 0 : video.currentTime || 0,
      playing: wasPlaying || !video.paused,
      rate: video.playbackRate || 1,
    };
    firstLoad = false;
    abort?.abort();
    const requestAbort = new AbortController();
    abort = requestAbort;
    if (!playbackUrl) {
      await load(
        { type: /\.m3u8(?:[?#]|$)/i.test(src) ? "hls" : "native", url: src },
        epoch,
      );
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const url = new URL(playbackUrl, window.location.href);
      if (url.origin !== window.location.origin)
        throw new Error("无效的播放源解析地址");
      if (refresh) url.searchParams.set("refresh", "1");
      timeout = setTimeout(() => requestAbort.abort(), 25_000);
      const response = await (options.fetch ?? window.fetch.bind(window))(
        url.href,
        {
          credentials: "same-origin",
          cache: "no-store",
          signal: requestAbort.signal,
        },
      );
      const data = (await response.json().catch(() => null)) as
        (PlaybackSource & { message?: string }) | null;
      if (disposed || epoch !== generation) return;
      if (!response.ok) {
        const messages: Record<number, string> = {
          401: "当前登录状态已失效，请重新登录",
          403: "当前账号无权访问该视频",
          404: "视频文件或分享凭证不存在、已失效",
          429: "网盘当前正在限流，请稍后重试",
        };
        throw new Error(
          data?.message ||
            messages[response.status] ||
            "获取播放源失败，请稍后重试",
        );
      }
      if (!data || !["hls", "native", "unavailable"].includes(data.type))
        throw new Error("播放源返回了无效数据");
      await load(data, epoch);
    } catch (error) {
      if (!disposed && epoch === generation)
        fail(
          error instanceof Error && error.name !== "AbortError"
            ? error.message
            : "获取网盘播放源超时，请稍后重试",
        );
    } finally {
      clearTimeout(timeout);
      if (epoch === generation) loading = false;
    }
  }
  async function load(source: PlaybackSource, epoch = generation) {
    if (disposed || epoch !== generation) return;
    hls?.destroy();
    hls = null;
    current = source;
    controller.error = null;
    if (source.type === "unavailable") {
      loading = false;
      fail(source.message || "网盘暂未提供可用的 HLS 播放源，请稍后重新获取");
      return;
    }
    if (!source.url) {
      loading = false;
      fail("视频源地址为空，请重新获取");
      return;
    }
    controller.url = source.url;
    if (source.type === "native") {
      if (options.loadNative) options.loadNative(source.url);
      else {
        video.src = source.url;
        video.load();
      }
      loading = false;
      video.dispatchEvent(new CustomEvent(PLAYBACK_SOURCE_READY));
      return;
    }
    try {
      const HlsCtor = await (options.loadHls?.() ??
        import("hls.js/light").then((module) => module.default));
      if (disposed || epoch !== generation) return;
      if (HlsCtor.isSupported()) {
        hls = new HlsCtor({
          enableWorker: true,
          backBufferLength: 30,
          maxBufferLength: video.preload === "metadata" ? 2 : 15,
          maxBufferSize: 4 * 1024 * 1024,
          manifestLoadingMaxRetry: 1,
          fragLoadingMaxRetry: 2,
        });
        hls.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (data.fatal && !disposed && epoch === generation)
            void recover("网盘 HLS 播放失败，请重新获取播放源或稍后重试");
        });
        hls.loadSource(source.url);
        hls.attachMedia(video);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = source.url;
        video.load();
      } else throw new Error("当前浏览器不支持 HLS，请换用新版浏览器");
      loading = false;
      video.dispatchEvent(new CustomEvent(PLAYBACK_SOURCE_READY));
    } catch (error) {
      loading = false;
      if (!disposed && epoch === generation)
        await recover(
          error instanceof Error ? error.message : "HLS 播放组件加载失败",
        );
    }
  }
  // Start synchronously for original files; metadata/HLS waits remain abortable.
  void resolve(!!options.refresh);
}
