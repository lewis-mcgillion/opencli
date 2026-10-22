import type { ToolCall, ToolSpec } from "../types";

interface Candidate {
  name?: unknown;
  arguments?: unknown;
  parameters?: unknown;
  input?: unknown;
}

function candidatesIn(text: string): unknown[] {
  const found: unknown[] = [];
  const pieces: string[] = [];
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) pieces.push(m[1]);
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) pieces.push(m[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) pieces.push(trimmed);
  for (const piece of pieces) {
    try {
      found.push(JSON.parse(piece.trim()));
    } catch {}
  }
  return found;
}

function flatten(value: unknown): Candidate[] {
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (value && typeof value === "object") return [value as Candidate];
  return [];
}

export function recoverTextToolCalls(text: string, tools: ToolSpec[]): ToolCall[] | null {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const calls: ToolCall[] = [];
  for (const parsed of candidatesIn(text)) {
    for (const cand of flatten(parsed)) {
      if (typeof cand.name !== "string") continue;
      const spec = byName.get(cand.name);
      if (!spec) continue;
      let args = cand.arguments ?? cand.parameters ?? cand.input ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { continue; }
      }
      if (!args || typeof args !== "object") continue;
      const required: string[] = spec.parameters?.required ?? [];
      if (required.some((k) => (args as Record<string, unknown>)[k] === undefined)) continue;
      calls.push({
        id: `recovered_${calls.length + 1}`,
        type: "function",
        function: { name: cand.name, arguments: JSON.stringify(args) },
      });
    }
  }
  return calls.length ? calls : null;
}
