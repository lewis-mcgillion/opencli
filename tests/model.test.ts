import { describe, expect, test } from "bun:test";
import { createOpenAIProvider } from "../src/model/openai";
import { recoverTextToolCalls } from "../src/model/fallback";
import { compactHistory, estimateTokens, needsCompaction, elideOldToolOutputs } from "../src/context";
import { startFakeModel } from "./helpers/fake-model";
import type { ToolSpec, Message, ModelProvider } from "../src/types";

const readSpec: ToolSpec = {
  name: "read_file",
  description: "read",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

describe("openai provider", () => {
  test("streams text, reports usage and sends tools", async () => {
    const fake = startFakeModel([{ text: "hello world", usage: { prompt: 7, completion: 3 } }]);
    try {
      const provider = createOpenAIProvider({ url: fake.url, apiKey: "k" });
      const deltas: string[] = [];
      const res = await provider.chat({
        model: "m",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
        tools: [readSpec],
        onText: (t) => deltas.push(t),
      });
      expect(deltas.join("")).toBe("hello world");
      expect(res.message.content).toBe("hello world");
      expect(res.usage).toEqual({ input: 7, output: 3 });
      expect(fake.requests[0].stream).toBe(true);
      expect(fake.requests[0].tools[0].function.name).toBe("read_file");
      expect(fake.requests[0].tool_choice).toBe("auto");
    } finally {
      fake.stop();
    }
  });

  test("assembles streamed tool calls", async () => {
    const fake = startFakeModel([{ toolCalls: [{ name: "read_file", arguments: { path: "a.txt" } }] }]);
    try {
      const res = await createOpenAIProvider({ url: fake.url }).chat({ model: "m", messages: [], tools: [readSpec] });
      expect(res.message.tool_calls?.length).toBe(1);
      expect(res.message.tool_calls?.[0].function.name).toBe("read_file");
      expect(JSON.parse(res.message.tool_calls![0].function.arguments)).toEqual({ path: "a.txt" });
    } finally {
      fake.stop();
    }
  });

  test("retries a 503 and reports the retry", async () => {
    const fake = startFakeModel([{ status: 503 }, { text: "ok" }]);
    try {
      const retries: number[] = [];
      const res = await createOpenAIProvider({ url: fake.url }).chat({
        model: "m",
        messages: [],
        tools: [],
        onRetry: (attempt) => retries.push(attempt),
      });
      expect(res.message.content).toBe("ok");
      expect(retries).toEqual([2]);
      expect(fake.requests.length).toBe(2);
    } finally {
      fake.stop();
    }
  });

  test("does not retry a 400", async () => {
    const fake = startFakeModel([{ status: 400 }]);
    try {
      await expect(createOpenAIProvider({ url: fake.url }).chat({ model: "m", messages: [], tools: [] })).rejects.toThrow("API 400");
      expect(fake.requests.length).toBe(1);
    } finally {
      fake.stop();
    }
  });
});

describe("text tool-call fallback", () => {
  test("recovers a fenced JSON call for a known tool", () => {
    const text = 'I will read it.\n```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```';
    const calls = recoverTextToolCalls(text, [readSpec]);
    expect(calls?.[0].function.name).toBe("read_file");
    expect(JSON.parse(calls![0].function.arguments)).toEqual({ path: "a.txt" });
  });

  test("recovers a <tool_call> tag with string arguments", () => {
    const text = '<tool_call>{"name":"read_file","parameters":"{\\"path\\":\\"b\\"}"}</tool_call>';
    expect(recoverTextToolCalls(text, [readSpec])?.length).toBe(1);
  });

  test("ignores unknown tools, missing required args and prose", () => {
    expect(recoverTextToolCalls('{"name":"delete_all","arguments":{}}', [readSpec])).toBeNull();
    expect(recoverTextToolCalls('{"name":"read_file","arguments":{}}', [readSpec])).toBeNull();
    expect(recoverTextToolCalls("Just reading the file now.", [readSpec])).toBeNull();
  });
});

describe("context management", () => {
  const big = "x".repeat(4000);
  const history: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: big },
    ...Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
  ];

  test("estimates tokens and flags compaction near the window", () => {
    expect(estimateTokens(history)).toBeGreaterThan(1000);
    expect(needsCompaction(history, 1000)).toBe(true);
    expect(needsCompaction(history, 1_000_000)).toBe(false);
  });

  test("elides old large tool outputs but keeps recent ones", () => {
    const copy = JSON.parse(JSON.stringify(history)) as Message[];
    elideOldToolOutputs(copy);
    expect(copy[3].content).toContain("[older output elided]");
    expect(copy[3].content!.length).toBeLessThan(400);
  });

  test("compaction keeps the system prompt and recent turns, replacing older ones with a summary", async () => {
    const seen: Message[][] = [];
    const provider: ModelProvider = {
      name: "stub",
      async chat(req) {
        seen.push(req.messages);
        return { message: { role: "assistant", content: "the summary" } };
      },
    };
    const copy = JSON.parse(JSON.stringify(history)) as Message[];
    const result = await compactHistory(provider, "m", copy);
    expect(result).not.toBeNull();
    expect(copy[0].content).toBe("sys");
    expect(copy[1].content).toBe("Summary of earlier conversation: the summary");
    expect(copy[copy.length - 1].content).toBe("m7");
    expect(seen[0][seen[0].length - 1].role).toBe("user");
  });
});
