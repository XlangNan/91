import type { Kind } from "./constants";

type Credentials = Record<string, string>;

// 本地存储没有需要在打开编辑表单时推断的历史字段，原样返回。
export function driveCredentialsForForm(
  _kind: Kind,
  credentials: Credentials
): Credentials {
  return { ...credentials };
}

// 本地存储的必填项由表单 required 属性校验，这里没有额外的互斥规则。
export function driveCredentialError(
  _kind: Kind,
  _credentials: Credentials,
  _isNew: boolean
): string {
  return "";
}

export function newDriveCredentialError(
  _kind: Kind,
  _credentials: Credentials
): string {
  return "";
}

// Build an edit patch from fields the form actually exposes. Runtime-managed
// values may exist in both records, but they must never be echoed back from a
// stale form snapshot unless the user can see and intentionally edit them.
export function changedCredentialValues(
  current: Credentials,
  initial: Credentials,
  editableKeys: readonly string[]
): Credentials {
  const changed: Credentials = {};
  for (const key of new Set(editableKeys)) {
    const currentValue = current[key] ?? "";
    if (currentValue !== (initial[key] ?? "")) {
      changed[key] = currentValue;
    }
  }
  return changed;
}
