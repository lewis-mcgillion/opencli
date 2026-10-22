import * as fs from "node:fs";
import { autoSessionName, saveSession } from "./session";
import { runTurn, type TurnResult } from "./agent";
import { resolvePath } from "./tools/files";
import { MAX_TOOL_CHARS } from "./execute";
import type { Runtime } from "./runtime";

const MENTION = /@((?:\/|~\/|\.\/)[^\s)\],'"]+)/g;

export function expandMentions(text: string, cwd: string): string {
  const attachments: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const abs = resolvePath(m[1], cwd);
    try {
      if (!fs.statSync(abs).isFile()) continue;
      const body = fs.readFileSync(abs, "utf-8").slice(0, MAX_TOOL_CHARS);
      attachments.push(`[File: ${m[1]}]\n${body}`);
    } catch {}
  }
  return attachments.length ? `${attachments.join("\n\n")}\n\n${text}` : text;
}

export function persist(rt: Runtime): void {
  if (rt.session.history.length <= 1) return;
  saveSession(autoSessionName(rt.cwd), {
    model: rt.state.model,
    mode: rt.state.mode,
    cwd: rt.cwd,
    messages: rt.session.history.slice(1),
  });
}

export async function submitMessage(rt: Runtime, text: string, allowedTools?: string[]): Promise<TurnResult> {
  rt.session.history.push({ role: "user", content: expandMentions(text, rt.cwd) });
  const allowed = allowedTools ? new Set(allowedTools) : null;
  try {
    if (rt.state.mode === "plan") {
      rt.ui.info("[plan mode: generating a plan; no tools will run until you approve]");
      const planned = await rt.provider.chat({
        model: rt.state.model,
        messages: rt.session.history,
        tools: [],
        signal: rt.signal,
        onText: (t) => rt.ui.text(t),
        onRetry: (attempt, reason) => rt.ui.info(`[retrying: attempt ${attempt}, ${reason}]`),
      });
      rt.session.history.push(planned.message);
      rt.ui.endMessage();
      if (!(await rt.ui.approve("Approve this plan and execute it?"))) {
        rt.session.history.pop();
        rt.ui.info("[plan rejected]");
        return { status: "done", steps: 0 };
      }
      rt.session.history.push({ role: "user", content: "The plan is approved. Carry it out now using the tools." });
    }
    return await runTurn(rt, { allowedTools: allowed });
  } finally {
    persist(rt);
  }
}
