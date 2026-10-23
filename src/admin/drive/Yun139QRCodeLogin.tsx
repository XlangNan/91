import { useEffect, useRef, useState } from "react";
import { QrCode } from "lucide-react";
import * as api from "../api";
import { useToast } from "@/components/ToastContext";

export function Yun139QRCodeLogin({ onAuthorization }: { onAuthorization: (authorization: string) => void }) {
  const { show } = useToast();
  const [session, setSession] = useState<api.Yun139QRSession | null>(null);
  const [status, setStatus] = useState<api.Yun139QRStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [pollingError, setPollingError] = useState("");
  const [completed, setCompleted] = useState(false);
  const callbacksRef = useRef({ onAuthorization, show });
  callbacksRef.current = { onAuthorization, show };
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
      const next = await api.startYun139QRLogin(controller.signal);
      if (!controller.signal.aborted) setSession(next);
    } catch (e) {
      if (!controller.signal.aborted) callbacksRef.current.show(e instanceof Error ? e.message : "生成二维码失败", "error");
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
    const remaining = Math.max(0, Date.parse(session.expiresAt) - Date.now());
    const expiryTimer = window.setTimeout(() => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      setPollingError("");
      setStatus({ state: "expired", statusText: "二维码已过期，请重新生成" });
    }, remaining);

    async function poll() {
      if (controller.signal.aborted) return;
      try {
        const next = await api.getYun139QRStatus(activeSession.sessionId, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        setPollingError("");
        if (next.state === "success") {
          window.clearTimeout(expiryTimer);
          if (!next.authorization) {
            setStatus({ state: "error", statusText: "扫码登录失败，请重新生成二维码" });
            setPollingError("登录成功但未获取到授权，请重新生成二维码");
            return;
          }
          setCompleted(true);
          const { onAuthorization, show } = callbacksRef.current;
          onAuthorization(next.authorization);
          show("扫码成功，已填入 Authorization，保存后生效", "success");
          return;
        }
        if (next.state === "expired" || next.state === "canceled" || next.state === "error") {
          window.clearTimeout(expiryTimer);
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
      window.clearTimeout(expiryTimer);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [session, completed]);

  return (
    <div className="admin-form__row admin-drive-qr-login">
      <span className="admin-form__label">扫码登录</span>
      <div className="admin-p123-qr">
        <div className="admin-p123-qr__actions">
          <button type="button" className="admin-btn" onClick={start} disabled={starting}>
            <QrCode size={14} />
            {starting ? "生成中..." : session ? "重新生成二维码" : "生成二维码"}
          </button>
        </div>
        {session && (
          <div className="admin-p123-qr__body">
            <img className="admin-p123-qr__image" src={session.qrImageDataUrl} alt="移动网盘扫码登录二维码" />
            <div className="admin-p123-qr__meta" aria-live="polite">
              <div className="admin-form__help">{status?.statusText || "请使用中国移动云盘 App 或微信扫码"}</div>
              {pollingError && <div className="admin-form__help">{pollingError}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
