// Minimal line-delimited JSON-RPC MCP server used by tests/mcp.test.ts.
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

function send(msg: object): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification, nothing to answer

  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: "fake", version: "1" },
      });
      return;

    case "tools/list":
      reply(id, {
        tools: [
          {
            name: "echo",
            description: "Echo the text back",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: "fail",
            description: "Always returns an error",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;

    case "tools/call": {
      if (process.env.FAKE_MCP_HANG === "1") return; // never answer
      const crashFile = process.env.FAKE_MCP_CRASH_ONCE_FILE;
      if (crashFile && !existsSync(crashFile)) {
        writeFileSync(crashFile, "crashed");
        process.exit(1);
      }
      const name = params?.name;
      if (name === "echo") {
        reply(id, { content: [{ type: "text", text: "echo:" + params.arguments?.text }] });
      } else if (name === "fail") {
        reply(id, { isError: true, content: [{ type: "text", text: "boom" }] });
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${name}` } });
      }
      return;
    }

    case "resources/list":
      reply(id, { resources: [{ uri: "mem://note", name: "note" }] });
      return;

    case "resources/read":
      reply(id, { contents: [{ uri: params?.uri, mimeType: "text/plain", text: "note-body" }] });
      return;

    case "prompts/list":
      reply(id, {
        prompts: [
          {
            name: "summarise",
            description: "Summarise a topic",
            arguments: [{ name: "topic", required: true }],
          },
        ],
      });
      return;

    case "prompts/get":
      reply(id, {
        messages: [
          {
            role: "user",
            content: { type: "text", text: "Summarise " + params?.arguments?.topic },
          },
        ],
      });
      return;

    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
