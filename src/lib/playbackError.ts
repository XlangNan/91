type StreamErrorPayload = {
  code?: unknown;
  message?: unknown;
};

export type PlaybackDiagnosticOptions = {
  baseHref?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

const MAX_SERVER_MESSAGE_LENGTH = 500;

/**
 * Ask the same-origin playback endpoint why a media element failed.
 *
 * HTMLMediaElement deliberately hides the HTTP response body, so a 502 is
 * otherwise surfaced as MEDIA_ERR_SRC_NOT_SUPPORTED. The diagnostic request
 * fetches only byte 0 and never follows a cloud-drive redirect.
 */
export async function diagnosePlaybackSource(
  src: string,
  options: PlaybackDiagnosticOptions = {}
): Promise<string | null> {
  const baseHref = options.baseHref ?? window.location.href;
  const pageURL = new URL(baseHref);
  const sourceURL = new URL(src, pageURL);
  if (!isSameOriginPlaybackURL(sourceURL, pageURL)) return null;

  const fetcher = options.fetch ?? window.fetch.bind(window);
  try {
    const response = await fetcher(sourceURL.href, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Range: "bytes=0-0",
      },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
      signal: options.signal,
    });

    // A 200/206 means the backend source is reachable; status 0 is the opaque
    // response produced for a manual cross-origin CDN redirect. In both cases
    // the original browser codec/network message remains the best diagnosis.
    if (response.status === 0 || response.status < 400) return null;

    const serverMessage = await readServerMessage(response);
    if (serverMessage) return serverMessage;

    switch (response.status) {
      case 401:
        return "当前登录状态已失效，请重新登录后播放";
      case 403:
        return "当前账号无权访问该视频源";
      case 404:
      case 410:
        if (sourceURL.pathname.startsWith("/p/share/")) {
          return "分享播放凭证已失效，请重新打开有效的一次性分享链接";
        }
        return "视频文件不存在或已失效，请联系管理员重新扫描";
      case 429:
        return "视频源当前正在限流，请稍后重试";
      default:
        if (response.status >= 500) {
          return `视频源服务暂时不可用（HTTP ${response.status}），请稍后重试或联系管理员`;
        }
        return `视频源请求失败（HTTP ${response.status}），请稍后重试`;
    }
  } catch {
    if (options.signal?.aborted) return null;
    return null;
  }
}

export function isSameOriginPlaybackURL(sourceURL: URL, pageURL: URL) {
  if (sourceURL.origin !== pageURL.origin) return false;
  return (
    sourceURL.pathname.startsWith("/p/stream/") ||
    sourceURL.pathname.startsWith("/p/upload/") ||
    sourceURL.pathname.startsWith("/p/share/")
  );
}

async function readServerMessage(response: Response) {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) return "";
  try {
    const payload = (await response.json()) as StreamErrorPayload;
    if (typeof payload.message !== "string") return "";
    const message = payload.message.trim();
    if (!message || message.length > MAX_SERVER_MESSAGE_LENGTH) return "";
    return message;
  } catch {
    return "";
  }
}
