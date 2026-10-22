import type { Message, ModelProvider } from "./types";

const KEEP_TAIL = 6;
const ELIDE_AFTER = 6;
const ELIDE_OVER_CHARS = 400;

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    for (const c of m.tool_calls ?? []) chars += c.function.arguments.length + c.function.name.length;
  }
  return Math.ceil(chars / 4);
}

export function elideOldToolOutputs(history: Message[]): void {
  for (const m of history.slice(1, -ELIDE_AFTER)) {
    if (m.role === "tool" && (m.content?.length ?? 0) > ELIDE_OVER_CHARS) {
      m.content = `${m.content!.slice(0, 300)}\n[older output elided]`;
    }
  }
}

export function needsCompaction(history: Message[], contextWindow: number): boolean {
  return estimateTokens(history) > contextWindow * 0.8;
}

function tailStart(history: Message[]): number {
  let start = Math.max(1, history.length - KEEP_TAIL);
  while (start < history.length && history[start].role !== "user") start++;
  return start;
}

export async function compactHistory(
  provider: ModelProvider,
  model: string,
  history: Message[],
  signal?: AbortSignal,
): Promise<{ removed: number } | null> {
  const start = tailStart(history);
  if (start <= 1) return null;
  const earlier = history.slice(1, start);
  const request: Message[] = [
    history[0],
    ...earlier,
    {
      role: "user",
      content: "Summarise the conversation so far in under 200 words. Keep the current goal, decisions made, file paths touched, and anything still open.",
    },
  ];
  const { message } = await provider.chat({ model, messages: request, tools: [], signal });
  const summary = (message.content ?? "").trim() || "(no summary)";
  history.splice(1, history.length - 1, { role: "user", content: `Summary of earlier conversation: ${summary}` }, ...history.slice(start));
  return { removed: earlier.length };
}
