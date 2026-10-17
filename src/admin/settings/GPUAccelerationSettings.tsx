import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { SettingsRow } from "./SettingsSection";

type Props = {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  onUnavailable: () => void;
};

function shortGPUName(name: string) {
  const model = name.match(/\[([^\]]*(?:Graphics|Radeon|RTX|RX|Arc|Iris|UHD)[^\]]*)\]/i)?.[1] ?? name;
  const compact = model
    .replace(/\((?:R|TM)\)|[®™]/gi, "")
    .replace(/^(?:NVIDIA\s+|Intel(?:\s+Corporation)?\s+|AMD\s+)/i, "")
    .replace(/^(?:GeForce|Radeon)\s+/i, "")
    .replace(/\s*\b(?:Laptop GPU|Laptop|Graphics)\b/gi, "")
    .trim();
  return compact && compact !== "GPU" ? compact : name;
}

export function GPUAccelerationSettings({ enabled, disabled, onChange, onUnavailable }: Props) {
  const [status, setStatus] = useState<api.GPUStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const probeRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      if (probeRequest.current) return;
      const sequence = ++requestSequence.current;
      void api.getGPUStatus(controller.signal).then((next) => {
        if (!controller.signal.aborted && sequence === requestSequence.current) setStatus(next);
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted && sequence === requestSequence.current) {
          setError(cause instanceof Error ? cause.message : "读取 GPU 状态失败");
        }
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      controller.abort();
      probeRequest.current?.abort();
      window.clearInterval(timer);
    };
  }, []);

  async function enableGPU() {
    if (checking || disabled) return;
    const controller = new AbortController();
    probeRequest.current = controller;
    ++requestSequence.current;
    setChecking(true);
    setError("");
    try {
      const next = await api.probeGPU(controller.signal);
      if (controller.signal.aborted) return;
      setStatus(next);
      if (next.available) {
        onChangeRef.current(true);
      } else {
        onUnavailable();
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "GPU 检测失败");
      }
    } finally {
      if (!controller.signal.aborted) {
        setChecking(false);
        probeRequest.current = null;
      }
    }
  }

  const gpuName = enabled && status?.available ? status.name?.trim() || "" : "";

  return (
    <div className="admin-config-gpu">
      <SettingsRow
        label={
          <span className="admin-config-gpu__label">
            <span id="generation-gpu-label">GPU 硬件加速</span>
            <span
              id="generation-gpu-detail"
              className="admin-config-gpu__detail"
              role="status"
              aria-live="polite"
              title={checking ? undefined : gpuName || undefined}
            >
              {checking ? "检测中" : shortGPUName(gpuName)}
            </span>
          </span>
        }
        layout="inline"
      >
        <div className="admin-config-control admin-config-control--switch">
          <button
            id="generation-gpu-toggle"
            type="button"
            className={`toggle-switch ${enabled ? "is-on" : ""}`}
            role="switch"
            aria-checked={enabled}
            aria-labelledby="generation-gpu-label"
            aria-describedby={checking || gpuName ? "generation-gpu-detail" : undefined}
            disabled={disabled || checking}
            onClick={() => enabled ? onChange(false) : void enableGPU()}
          >
            <span className="toggle-switch__dot" />
          </button>
        </div>
      </SettingsRow>
      {error && (
        <p className="admin-config-gpu__error" role="alert">{error}</p>
      )}
      {Boolean(status?.fallbackCount) && (
        <p className="admin-config-gpu__note">
          本次运行已有 {status?.fallbackCount} 个任务回退 CPU，原因见运行日志。
        </p>
      )}
    </div>
  );
}
