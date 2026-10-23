import type { ChatRequest, ChatResult, Message, ModelProvider, ToolCall } from "../types";
import { postJsonWithRetry } from "./http";
import { readSse } from "./sse";

export interface OpenAIOptions {
  url: string;
  apiKey?: string;
  azure?: boolean;
}

export function createOpenAIProvider(opts: OpenAIOptions): ModelProvider {
  return {
    name: "openai",
    async chat(req: ChatRequest): Promise<ChatResult> {
      const headers: Record<string, string> = {};
      if (opts.apiKey) {
        if (opts.azure) headers["api-key"] = opts.apiKey;
        else headers.Authorization = `Bearer ${opts.apiKey}`;
      }
      const body = {
        model: req.model,
        messages: req.messages,
        tools: req.tools.length ? req.tools.map((t) => ({ type: "function", function: t })) : undefined,
        tool_choice: req.tools.length ? "auto" : undefined,
        stream: true,
        stream_options: { include_usage: true },
      };
      const res = await postJsonWithRetry(`${opts.url}/chat/completions`, body, {
        headers,
        signal: req.signal,
        onRetry: req.onRetry,
      });
      if (!res.body) throw new Error("empty response from model server");

      let text = "";
      const calls: Array<ToolCall | undefined> = [];
      let usage: ChatResult["usage"];
      for await (const event of readSse(res.body)) {
        if (event.data === "[DONE]") break;
        const parsed = JSON.parse(event.data);
        if (parsed.usage) {
          usage = { input: parsed.usage.prompt_tokens ?? 0, output: parsed.usage.completion_tokens ?? 0 };
        }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          text += delta.content;
          req.onText?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const call = (calls[idx] ??= {
            id: tc.id ?? `call_${idx}`,
            type: "function",
            function: { name: "", arguments: "" },
          });
          if (tc.function?.name) call.function.name += tc.function.name;
          if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
        }
      }

      const toolCalls = calls.filter((c): c is ToolCall => c !== undefined && c.function.name !== "");
      const message: Message = { role: "assistant", content: text };
      if (toolCalls.length) message.tool_calls = toolCalls;
      return { message, usage };
    },
  };
}
