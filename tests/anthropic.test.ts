import { test, expect, afterEach } from "bun:test";
import { createAnthropicProvider } from "../src/model/anthropic";
import type { Message, ToolSpec } from "../src/types";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

type Handler = (req: Request, body: any, n: number) => Response | Promise<Response>;

function startServer(handler: Handler) {
  const calls: Array<{ headers: Headers; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || url.pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      const body = await req.json();
      calls.push({ headers: req.headers, body });
      return handler(req, body, calls.length);
    },
  });
  servers.push(server);
  return { url: `http://localhost:${server.port}/v1`, calls };
}

function sse(events: Array<[string, unknown]>): Response {
  const text = events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

test("plain text streaming emits deltas in order and returns joined content", async () => {
  const srv = startServer(() =>
    sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
      ["message_stop", { type: "message_stop" }],
    ]),
  );

  const chunks: string[] = [];
  const provider = createAnthropicProvider({ url: srv.url, maxTokens: 1024 });
  const result = await provider.chat({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onText: (t) => chunks.push(t),
  });

  expect(chunks).toEqual(["Hel", "lo", " world"]);
  expect(result.message.role).toBe("assistant");
  expect(result.message.content).toBe("Hello world");
  expect(result.message.tool_calls).toBeUndefined();
  expect(result.usage).toEqual({ input: 12, output: 7 });
  expect(srv.calls[0].body.stream).toBe(true);
  expect(srv.calls[0].body.max_tokens).toBe(1024);
  expect(srv.calls[0].body.model).toBe("claude-test");
});

test("tool_use streaming assembles one tool_call from split input_json_delta fragments", async () => {
  const srv = startServer(() =>
    sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
        },
      ],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th": "src/' } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'a.ts"}' } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }],
      ["message_stop", { type: "message_stop" }],
    ]),
  );

  const provider = createAnthropicProvider({ url: srv.url, maxTokens: 1024 });
  const result = await provider.chat({
    model: "claude-test",
    messages: [{ role: "user", content: "read it" }],
    tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
  });

  expect(result.message.content).toBe("Let me check.");
  expect(result.message.tool_calls).toEqual([
    {
      id: "toolu_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path": "src/a.ts"}' },
    },
  ]);
  expect(JSON.parse(result.message.tool_calls![0].function.arguments)).toEqual({ path: "src/a.ts" });
  expect(result.usage).toEqual({ input: 30, output: 20 });
});

test("request conversion maps system, tool_use, merged tool_results, headers and tools", async () => {
  const srv = startServer(() =>
    sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["message_stop", { type: "message_stop" }],
    ]),
  );

  const messages: Message[] = [
    { role: "system", content: "You are helpful." },
    { role: "system", content: "Be brief." },
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        { id: "toolu_a", type: "function", function: { name: "ls", arguments: '{"dir":"."}' } },
        { id: "toolu_b", type: "function", function: { name: "ls", arguments: '{"dir":"src"}' } },
      ],
    },
    { role: "tool", content: "a.txt", tool_call_id: "toolu_a", name: "ls" },
    { role: "tool", content: "b.txt", tool_call_id: "toolu_b", name: "ls" },
  ];
  const tools: ToolSpec[] = [
    {
      name: "ls",
      description: "List",
      parameters: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] },
    },
  ];

  const provider = createAnthropicProvider({ url: srv.url, apiKey: "secret", maxTokens: 512 });
  await provider.chat({ model: "claude-test", messages, tools });

  const { headers, body } = srv.calls[0];
  expect(headers.get("x-api-key")).toBe("secret");
  expect(headers.get("anthropic-version")).toBe("2023-06-01");

  expect(body.system).toBe("You are helpful.\n\nBe brief.");
  expect(body.messages.some((m: any) => m.role === "system")).toBe(false);
  expect(body.messages).toHaveLength(3);

  expect(body.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "list files" }] });
  expect(body.messages[1]).toEqual({
    role: "assistant",
    content: [
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "toolu_a", name: "ls", input: { dir: "." } },
      { type: "tool_use", id: "toolu_b", name: "ls", input: { dir: "src" } },
    ],
  });
  expect(body.messages[2]).toEqual({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_a", content: "a.txt" },
      { type: "tool_result", tool_use_id: "toolu_b", content: "b.txt" },
    ],
  });

  expect(body.tools).toEqual([
    {
      name: "ls",
      description: "List",
      input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] },
    },
  ]);
  expect(body.tool_choice).toEqual({ type: "auto" });
});

test("omits tools, tool_choice and x-api-key when not configured", async () => {
  const srv = startServer(() =>
    sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["message_stop", { type: "message_stop" }],
    ]),
  );

  const provider = createAnthropicProvider({ url: srv.url, maxTokens: 64 });
  await provider.chat({ model: "claude-test", messages: [{ role: "user", content: "hi" }], tools: [] });

  const { headers, body } = srv.calls[0];
  expect(body.tools).toBeUndefined();
  expect(body.tool_choice).toBeUndefined();
  expect(body.system).toBeUndefined();
  expect(headers.get("x-api-key")).toBeNull();
});

test("retries a 503 and reports the retry via onRetry", async () => {
  const srv = startServer((_req, _body, n) => {
    if (n === 1) return new Response("overloaded", { status: 503 });
    return sse([
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  });

  const retries: Array<{ attempt: number; reason: string }> = [];
  const provider = createAnthropicProvider({ url: srv.url, maxTokens: 64 });
  const result = await provider.chat({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    onRetry: (attempt, reason) => retries.push({ attempt, reason }),
  });

  expect(srv.calls).toHaveLength(2);
  expect(retries).toHaveLength(1);
  expect(retries[0].attempt).toBe(2);
  expect(retries[0].reason).toContain("HTTP 503");
  expect(retries[0].reason).toContain("backing off");
  expect(result.message.content).toBe("ok");
});

test("non-retryable 400 throws an error containing the status", async () => {
  const srv = startServer(
    () =>
      new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );

  const provider = createAnthropicProvider({ url: srv.url, maxTokens: 64 });
  await expect(
    provider.chat({ model: "claude-test", messages: [{ role: "user", content: "hi" }], tools: [] }),
  ).rejects.toThrow(/400/);
  expect(srv.calls).toHaveLength(1);
});
