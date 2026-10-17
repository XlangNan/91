import { useEffect, useRef, useState } from "react";
import { QrCode } from "lucide-react";
import * as api from "../api";
import { useToast } from "@/components/ToastContext";

export function P115QRCodeLogin({ onCookie }: { onCookie: (cookie: string) => void }) {
  const { show } = useToast();
  const [session, setSession] = useState<api.P115QRSession | null>(null);
  const [status, setStatus] = useState<api.P115QRStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [pollingError, setPollingError] = useState("");
  const [completed, setCompleted] = useState(false);
  const callbacksRef = useRef({ onCookie, show });
  callbacksRef.current = { onCookie, show };
  const startControllerRef = useRef<AbortController | null>(null);
  const pollControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => startControllerRef.current?.abort(), []);

  async function start() {
    startControllerRef.current?.abort();
    pollControllerRef.current?.abort();
    const controller = new AbortController();
    startControllerRef.current = controller;
    setStarting(true);
    setSession(null);
    setStatus(null);
    setPollingError("");
    setCompleted(false);
    try {
      const next = await api.startP115QRLogin(controller.signal);
      if (controller.signal.aborted) return;
      setSession(next);
    } catch (e) {
      if (controller.signal.aborted) return;
      callbacksRef.current.show(e instanceof Error ? e.message : "生成二维码失败", "error");
    } finally {
      if (!controller.signal.aborted) setStarting(false);
    }
  }

  useEffect(() => {
    if (!session || completed) return;
    const activeSession = session;
    const controller = new AbortController();
    pollControllerRef.current = controller;
    let timer: number | undefined;

    async function poll() {
      if (controller.signal.aborted) return;
      try {
        const next = await api.getP115QRStatus(activeSession, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        setPollingError("");
        if (next.state === "success") {
          if (!next.cookie) {
            setPollingError("登录成功但未获取到 Cookie，请重新生成二维码");
            return;
          }
          setCompleted(true);
          const { onCookie, show } = callbacksRef.current;
          onCookie(next.cookie);
          show("扫码成功，已填入 Cookie，保存后生效", "success");
          return;
        }
        if (
          next.state === "expired" ||
          next.state === "canceled" ||
          next.state === "error"
        ) {
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setPollingError(e instanceof Error ? e.message : "查询扫码状态失败");
      }
      if (!controller.signal.aborted) timer = window.setTimeout(poll, 2000);
    }

    poll();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [session, completed]);

  return (
    <div className="admin-form__row">
      <label>方式一</label>
      <div className="admin-p123-qr">
        <div className="admin-p123-qr__actions">
          <button
            type="button"
            className="admin-btn"
            onClick={start}
            disabled={starting}
          >
            <QrCode size={14} />
            {starting ? "生成中..." : session ? "重新生成二维码" : "生成二维码"}
          </button>
        </div>

        {session && (
          <div className="admin-p123-qr__body">
            <img
              className="admin-p123-qr__image"
              src={session.qrImageDataUrl}
              alt="115 网盘扫码登录二维码"
            />
            <div className="admin-p123-qr__meta" aria-live="polite">
              {pollingError && (
                <div className="admin-form__help">
                  {pollingError}
                </div>
              )}
              {status?.state === "scanned" && (
                <div className="admin-form__help">已扫码，请在 115 App 确认登录。</div>
              )}
              {(status?.state === "expired" || status?.state === "canceled") && (
                <div className="admin-form__help">
                  当前二维码{status.state === "canceled" ? "已取消" : "已过期"}，请重新生成。
                </div>
              )}
              {status?.state === "error" && (
                <div className="admin-form__help">扫码状态异常，请重新生成二维码。</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
