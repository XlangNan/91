import { useCallback, useRef, useState } from "react";

const MUTED_STORAGE_KEY = "shorts:muted";

function readMutedPreference() {
  try {
    return localStorage.getItem(MUTED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** 用户偏好持久保存；自动播放策略导致的静音只在本次页面内生效。 */
export function useShortsAudio() {
  const [muted, updateMuted] = useState(readMutedPreference);
  // 每次声音选择都更换快照，避免旧 play() 的拒绝覆盖用户的新选择。
  const audioStateRef = useRef({ muted });

  const setMuted = useCallback((next: boolean) => {
    audioStateRef.current = { muted: next };
    updateMuted(next);
    try {
      localStorage.setItem(MUTED_STORAGE_KEY, String(next));
    } catch {
      // 存储不可用时仍允许当前页面正常切换声音。
    }
  }, []);

  const playWithAudioFallback = useCallback(async (
    video: HTMLVideoElement,
    isCurrent: () => boolean,
  ) => {
    let audioState = audioStateRef.current;
    const canContinue = () => isCurrent() && audioStateRef.current === audioState;
    if (!canContinue()) return;

    video.muted = audioState.muted;
    video.defaultMuted = audioState.muted;
    try {
      await video.play();
    } catch (error: unknown) {
      if (!canContinue()) return;
      const isNotAllowed = typeof error === "object" && error !== null &&
        "name" in error && error.name === "NotAllowedError";
      if (audioState.muted || !isNotAllowed) throw error;

      // 只有有声播放被策略拦截才回退；不把临时静音写成用户偏好。
      audioState = { muted: true };
      audioStateRef.current = audioState;
      updateMuted(true);
      video.muted = true;
      video.defaultMuted = true;
      try {
        await video.play();
      } catch (fallbackError: unknown) {
        if (canContinue()) throw fallbackError;
      }
    }
  }, []);

  return { muted, setMuted, playWithAudioFallback };
}
