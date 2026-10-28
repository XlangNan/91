import localstorageIcon from "./icons/localstorage.png";
import { scanOutcomeClasses, scanOutcomeLabels } from "./scanResults";

export type Kind = "localstorage";

export const kindAbbr: Record<string, string> = {
  localstorage: "Lo",
};

export const kindIconPath: Record<string, string> = {
  localstorage: localstorageIcon,
};

export function driveKindAbbr(kind: string): string {
  const explicit = kindAbbr[kind];
  if (explicit) return explicit;

  const trimmed = kind.trim();
  if (!trimmed) return "??";
  const compact = trimmed.replace(/[^a-zA-Z0-9]+/g, "");
  return (compact || trimmed).slice(0, 2).toUpperCase();
}

export function driveKindIconPath(kind: string): string {
  return kindIconPath[kind] || "";
}

export const kindLabel: Record<string, string> = {
  localstorage: "本地存储",
};

export type FormState = {
  id: string;
  kind: Kind;
  name: string;
  rootId: string;
  creds: Record<string, string>;
};

export const emptyForm: FormState = {
  id: "",
  kind: "localstorage",
  name: "",
  rootId: "",
  creds: {},
};

export function scanAllButtonText(status: { running: boolean; queued: boolean }, triggering: boolean) {
  if (triggering) return "触发中...";
  if (status.running) return "扫描运行中";
  if (status.queued) return "扫描已排队";
  return "扫描所有存储";
}

export function maintenanceBusyText(status: { running: boolean; queued: boolean }) {
  if (status.running || status.queued) return "当前有全量扫描任务正在进行，请稍后重试";
  return "";
}

export function generationStateLabel(state: string): string {
  if (Object.prototype.hasOwnProperty.call(scanOutcomeLabels, state)) return scanOutcomeLabels[state as keyof typeof scanOutcomeLabels];
  if (state === "scanning") return "扫盘中";
  if (state === "uploading") return "上传中";
  if (state === "generating") return "生成中";
  if (state === "cooling") return "冷却中";
  if (state === "queued") return "排队中";
  return "空闲";
}

export function generationStateClass(state: string): string {
  if (Object.prototype.hasOwnProperty.call(scanOutcomeClasses, state)) return scanOutcomeClasses[state as keyof typeof scanOutcomeClasses];
  if (state === "scanning" || state === "uploading" || state === "generating" || state === "cooling" || state === "queued") {
    if (state === "scanning" || state === "uploading") return "generating";
    return state;
  }
  return "idle";
}

export function generationDetail(status?: { state: string; cooldownUntil?: string; currentTitle?: string }): string {
  if (!status) return "";
  if (status.state === "cooling" && status.cooldownUntil) {
    return `剩余 ${formatCooldownRemaining(status.cooldownUntil)}`;
  }
  if (status.currentTitle) {
    return status.currentTitle;
  }
  return "";
}

export function generationTitle(status: { state: string; cooldownUntil?: string; currentTitle?: string } | undefined, detail: string): string | undefined {
  if (!status) return detail || undefined;
  if (status.state === "cooling" && status.cooldownUntil) {
    return `冷却至 ${formatClock(status.cooldownUntil)}`;
  }
  return status.currentTitle || detail || undefined;
}

export function formatCooldownRemaining(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const totalSeconds = Math.max(0, Math.ceil((d.getTime() - Date.now()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分`;
  if (minutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

export function formatClock(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function defaultRootId(_kind: Kind): string {
  return "/";
}

export function usesRootDirectoryID(_kind: Kind): boolean {
  return false;
}

export function rootIdPlaceholder(_kind: Kind): string {
  return "";
}

export function rootDirectoryLabel(_kind: Kind): string {
  return "";
}

export type CredentialField = {
  key: string;
  label: string;
  placeholder: string;
  methodLabel?: string;
  type?: "text" | "select";
  options?: Array<{ value: string; label: string }>;
  multiline?: boolean;
  required?: boolean;
  defaultValue?: string;
  visibleWhen?: { key: string; value: string };
};

export function credentialFields(_kind: Kind): CredentialField[] {
  return [
    {
      key: "path",
      label: "本地目录路径",
      placeholder: "/media（容器内路径，对应群晖资源文件夹）",
      required: true,
    },
    {
      key: "strm_allow_outside_root",
      label: ".strm 允许指向目录外",
      placeholder: "",
      type: "select",
      defaultValue: "false",
      options: [
        { value: "false", label: "关闭（默认，仅允许目录内路径）" },
        { value: "true", label: "开启（允许任意本地路径）" },
      ],
    },
  ];
}
