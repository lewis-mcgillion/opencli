import { decide } from "./permissions";
import { runAdvisoryHooks, runPreToolHooks } from "./hooks";
import type { Runtime } from "./runtime";
import type { ToolResult } from "./types";

export const MAX_TOOL_CHARS = 8000;

export function clip(s: string, n = MAX_TOOL_CHARS): string {
  return s.length > n ? `${s.slice(0, n)}\n[output truncated: ${s.length - n} more chars]` : s;
}

function failure(message: string, denied = false): ToolResult {
  return { output: `Error: ${message}`, isError: true, denied };
}

export async function executeTool(rt: Runtime, name: string, argsJson: string): Promise<ToolResult> {
  const tool = rt.tools.find((t) => t.name === name);
  if (!tool) {
    return failure(`unknown tool "${name}". Available: ${rt.tools.map((t) => t.name).join(", ")}`);
  }
  if (rt.allowedTools && !rt.allowedTools.has(name)) {
    return failure(`tool ${name} is not available in this context.`);
  }

  let args: any;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return failure("tool arguments were not valid JSON.");
  }
  const missing = (tool.parameters.required ?? []).filter((k: string) => args?.[k] === undefined);
  if (missing.length) return failure(`missing required parameter(s): ${missing.join(", ")}.`);

  const subject = tool.subject?.(args) ?? "";
  const decision = decide(
    { name: tool.name, kind: tool.kind, subject, shellCommand: tool.shellCommand?.(args) },
    rt.state.mode,
    rt.config.permissions,
  );
  if (decision.action === "deny") return deny(rt, decision.reason);

  const explicitAllow = decision.explicit === true;
  if (tool.preflight && !explicitAllow) {
    const stop = await tool.preflight(args, rt);
    if (stop) return stop.denied ? deny(rt, stop.message) : failure(stop.message);
  }

  if (decision.action === "ask") {
    if (!rt.ui.canAsk) return deny(rt, `${decision.reason}; approval is required but no user is available`);
    const preview = tool.preview ? await tool.preview(args, rt) : null;
    if (preview) rt.ui.preview(preview.title, preview.body);
    const question = `Allow ${tool.name}${subject ? `: ${subject.slice(0, 120)}` : ""}? (${decision.reason})`;
    if (!(await rt.ui.approve(question))) return deny(rt, "the user rejected this action");
  }

  const hookPayload = { event: "pre_tool" as const, tool: name, args, cwd: rt.cwd };
  const hookVerdict = await runPreToolHooks(rt.config.hooks.pre_tool, hookPayload);
  if (hookVerdict.deny) return deny(rt, `blocked by hook: ${hookVerdict.message}`);

  let output: string;
  let isError = false;
  try {
    output = await tool.run(args, rt, { explicitAllow });
  } catch (e: any) {
    output = `Error: ${e.message}`;
    isError = true;
  }

  const notes = await runAdvisoryHooks(rt.config.hooks.post_tool, { event: "post_tool", tool: name, args, output, is_error: isError, cwd: rt.cwd });
  if (notes.length) output += `\n[${notes.join("\n[")}]`;
  return { output: clip(output), isError, denied: false };
}

function deny(rt: Runtime, reason: string): ToolResult {
  rt.session.denials++;
  return failure(reason, true);
}
