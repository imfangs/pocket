import type { ApprovalOption, PendingRequest } from "./conversationFeed";

const kinds = ["accept", "acceptForSession", "execpolicy", "networkPolicy", "decline", "cancel", "permissionTurn", "permissionSession"];
const scopes = ["once", "session", "rule", "turn"];
const fields = ["id", "kind", "scope", "rule", "host", "action", "grantRoot"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function ambiguousApprovalScope(value: string) {
  if (/[\x00-\x1f\x7f-\x9f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u206f]/.test(value)) return true;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !ambiguousApprovalScope(value);

export function hasNativeApprovalOptions(request: PendingRequest) {
  return Object.prototype.hasOwnProperty.call(request, "approvalOptions");
}

// Presentation validation is deliberately narrower than arbitrary native
// payloads. Unknown dimensions cannot become an incompletely reviewed grant.
export function nativeApprovalOptions(request: PendingRequest): ApprovalOption[] {
  const values: unknown = request.approvalOptions;
  if (!Array.isArray(values)) return [];
  const valid: ApprovalOption[] = [];
  const duplicate = new Set<string>(), seen = new Set<string>();
  for (const value of values as unknown[]) {
    if (!record(value) || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id) ||
      typeof value.kind !== "string" || !kinds.includes(value.kind) || typeof value.scope !== "string" || !scopes.includes(value.scope) ||
      Object.keys(value).some(field => !fields.includes(field))) continue;
    if (seen.has(value.id)) duplicate.add(value.id); else seen.add(value.id);
    const extras = Object.keys(value).filter(field => !["id", "kind", "scope"].includes(field));
    const only = (...allowed: string[]) => extras.every(field => allowed.includes(field));
    let allowed = false;
    if (value.kind === "accept") allowed = value.scope === "once" && only() ||
      request.kind === "file" && value.scope === "session" && only("grantRoot") && text(value.grantRoot);
    else if (value.kind === "acceptForSession") allowed = value.scope === "session" &&
      (request.kind === "command" && only() || request.kind === "file" && (only() || only("grantRoot") && text(value.grantRoot)));
    else if (value.kind === "execpolicy") allowed = request.kind === "command" && value.scope === "rule" && only("rule") &&
      Array.isArray(value.rule) && !!value.rule.length && value.rule.every(word => typeof word === "string" && !ambiguousApprovalScope(word));
    else if (value.kind === "networkPolicy") allowed = request.kind === "command" && value.scope === "rule" && only("host", "action") &&
      text(value.host) && typeof value.action === "string" && ["allow", "deny"].includes(value.action);
    else if (value.kind === "permissionTurn" || value.kind === "permissionSession") allowed = request.kind === "permissions" && only() &&
      value.scope === (value.kind === "permissionTurn" ? "turn" : "session");
    else allowed = only();
    if (!allowed) continue;
    valid.push({ id: value.id, kind: value.kind as ApprovalOption["kind"], scope: value.scope as ApprovalOption["scope"],
      ...(value.rule === undefined ? {} : { rule: [...value.rule as string[]] }), ...(value.host === undefined ? {} : { host: value.host as string }),
      ...(value.action === undefined ? {} : { action: value.action as "allow" | "deny" }), ...(value.grantRoot === undefined ? {} : { grantRoot: value.grantRoot as string }) });
  }
  return valid.filter(option => !duplicate.has(option.id));
}

export function approvalRuleText(words: readonly string[]) {
  return words.map(word => /^[A-Za-z0-9@%_+=:,./-]+$/.test(word) ? word : JSON.stringify(word)).join(" ");
}

export function nativeApprovalView(request: Pick<PendingRequest, "kind">, option: ApprovalOption) {
  if (option.kind === "accept" && option.grantRoot) return { label: "允许目录授权", scope: "本会话", value: option.grantRoot, primary: false };
  if (option.kind === "accept") return { label: "允许这一次", scope: "", primary: true };
  if (option.kind === "acceptForSession") return { label: request.kind === "file" ? "这些文件后续允许" : "本会话内允许",
    scope: request.kind === "file" ? "本会话 · 上方这些文件" : "本会话", value: option.grantRoot, primary: false };
  if (option.kind === "execpolicy") return { label: "允许命令前缀", scope: "命令前缀", value: approvalRuleText(option.rule!), primary: false };
  if (option.kind === "networkPolicy") return { label: option.action === "allow" ? "添加网络允许规则" : "添加网络拒绝规则", scope: "主机", value: option.host, primary: false };
  if (option.kind === "permissionTurn") return { label: "允许本轮", scope: "范围：上方申请的权限", primary: true };
  if (option.kind === "permissionSession") return { label: "本会话允许这些权限", scope: "范围：上方申请的权限", primary: false };
  return { label: request.kind === "permissions" ? "拒绝权限" : option.kind === "cancel" ? "中断执行" : "拒绝操作", scope: "", primary: false };
}
