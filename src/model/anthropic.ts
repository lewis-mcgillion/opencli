import type { ChatRequest, ChatResult, Message, ModelProvider, ToolCall } from "../types";
import { postJsonWithRetry } from "./http";
import { readSse } from "./sse";

export interface AnthropicOptions {
  url: string;
  apiKey?: string;
  maxTokens: number;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

type StreamBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; json: string };

function parseArgs(args: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toAnthropicMessages(messages: Message[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  // Consecutive messages with the same role are merged so roles alternate,
  // which also folds all tool_results of one turn into a single user message.
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    switch (m.role) {
      case "system":
        if (m.content) systemParts.push(m.content);
        break;
      case "user":
        push("user", m.content?.trim() ? [{ type: "text", text: m.content }] : []);
        break;
      case "assistant": {
        const blocks: AnthropicBlock[] = [];
        if (m.content?.trim()) blocks.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
        }
        push("assistant", blocks);
        break;
      }
      case "tool":
        push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content ?? "" }]);
        break;
    }
  }

  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
}

export function createAnthropicProvider(opts: AnthropicOptions): ModelProvider {
  return {
    name: "anthropic",
    async chat(req: ChatRequest): Promise<ChatResult> {
      const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
      if (opts.apiKey) headers["x-api-key"] = opts.apiKey;

      const converted = toAnthropicMessages(req.messages);
      const body = {
        model: req.model,
        max_tokens: opts.maxTokens,
        system: converted.system,
        messages: converted.messages,
        tools: req.tools.length
          ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
          : undefined,
        tool_choice: req.tools.length ? { type: "auto" } : undefined,
        stream: true,
      };

      const res = await postJsonWithRetry(`${opts.url}/messages`, body, {
        headers,
        signal: req.signal,
        onRetry: req.onRetry,
      });
      if (!res.body) throw new Error("empty response from model server");

      const blocks = new Map<number, StreamBlock>();
      let input = 0;
      let output = 0;
      let stopped = false;

      const appendText = (index: number, chunk: string) => {
        let block = blocks.get(index);
        if (!block) {
          block = { type: "text", text: "" };
          blocks.set(index, block);
        }
        if (block.type !== "text") return;
        block.text += chunk;
        req.onText?.(chunk);
      };

      stream: for await (const event of readSse(res.body)) {
        if (!event.data) continue;
        const data = JSON.parse(event.data);
        switch (data.type) {
          case "message_start":
            input = data.message?.usage?.input_tokens ?? input;
            output = data.message?.usage?.output_tokens ?? output;
            break;
          case "content_block_start": {
            const cb = data.content_block;
            if (cb?.type === "text") {
              blocks.set(data.index, { type: "text", text: "" });
              if (cb.text) appendText(data.index, cb.text);
            } else if (cb?.type === "tool_use") {
              blocks.set(data.index, { type: "tool_use", id: cb.id, name: cb.name, json: "" });
            }
            break;
          }
          case "content_block_delta": {
            const delta = data.delta;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              appendText(data.index, delta.text);
            } else if (delta?.type === "input_json_delta") {
              const block = blocks.get(data.index);
              if (block?.type === "tool_use") block.json += delta.partial_json ?? "";
            }
            break;
          }
          case "message_delta":
            if (data.usage?.output_tokens != null) output = data.usage.output_tokens;
            break;
          case "error":
            throw new Error("Anthropic stream error: " + data.error?.message);
          case "message_stop":
            stopped = true;
            break stream;
        }
      }
      if (!stopped) throw new Error("Anthropic stream ended before message_stop");

      const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
      const content = ordered
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("");
      const toolCalls: ToolCall[] = ordered.flatMap((b) =>
        b.type === "tool_use"
          ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: b.json || "{}" } }]
          : [],
      );

      const message: Message = { role: "assistant", content };
      if (toolCalls.length) message.tool_calls = toolCalls;
      return { message, usage: { input, output } };
    },
  };
}
