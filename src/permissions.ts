import type { Permissions } from "./config";
import type { Mode, ToolKind } from "./types";
import { analyzeShell, hasShellOperators } from "./shell-guard";

export type Action = "allow" | "ask" | "deny";

export interface Decision {
  action: Action;
  reason: string;
  explicit?: boolean;
}

export interface Subject {
  name: string;
  kind: ToolKind;
  subject: string;
  shellCommand?: string;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s");
}

export function parseRule(rule: string): { tool: string; pattern: string | null } {
  const m = /^([A-Za-z0-9_*-]+)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return { tool: rule.trim(), pattern: null };
  return { tool: m[1], pattern: m[2] ?? null };
}

function segmentsOf(command: string): string[] {
  return [command, ...command.split(/[;&|\n()`]|\$\(/).map((s) => s.trim()).filter(Boolean)];
}

export function ruleMatches(rule: string, s: Subject, candidates: string[]): boolean {
  const { tool, pattern } = parseRule(rule);
  if (!globToRegExp(tool).test(s.name)) return false;
  if (pattern === null) return true;
  const re = globToRegExp(pattern);
  return candidates.some((c) => re.test(c));
}

function firstMatch(rules: string[], s: Subject, candidates: string[]): string | null {
  return rules.find((rule) => ruleMatches(rule, s, candidates)) ?? null;
}

export function decide(s: Subject, mode: Mode, perms: Permissions): Decision {
  const isShell = s.shellCommand !== undefined;
  const broadCandidates = isShell ? segmentsOf(s.shellCommand!) : [s.subject];
  const deny = firstMatch(perms.deny, s, broadCandidates);
  if (deny) return { action: "deny", reason: `denied by rule ${deny}` };
  const ask = firstMatch(perms.ask, s, broadCandidates);
  if (ask) return { action: "ask", reason: `rule ${ask} requires approval` };
  const exact = isShell ? !hasShellOperators(s.shellCommand!) : true;
  const allow = exact ? firstMatch(perms.allow, s, [s.subject]) : null;
  if (allow) return { action: "allow", reason: `allowed by rule ${allow}`, explicit: true };

  switch (s.kind) {
    case "read":
    case "meta":
    case "network":
      return { action: "allow", reason: "" };
    case "write":
      return mode === "auto" ? { action: "allow", reason: "" } : { action: "ask", reason: "edits a file" };
    case "exec": {
      if (isShell) {
        const verdict = analyzeShell(s.shellCommand!);
        if (verdict.safe || mode === "auto") return { action: "allow", reason: "" };
        return { action: "ask", reason: verdict.reasons.join("; ") };
      }
      return mode === "auto" ? { action: "allow", reason: "" } : { action: "ask", reason: "runs a tool with side effects" };
    }
  }
}
