import type { McpServerConfig } from "../config";
import type { Command } from "../commands/index";
import type { ToolDef } from "../runtime";
import type { Ui } from "../types";
import { McpClient } from "./client";

export interface McpHandle {
  clients: Map<string, McpClient>;
  tools: ToolDef[];
  commands: Command[];
  summary(): string;
  stop(): void;
}

interface ServerState {
  client: McpClient;
  tools: any[];
  prompts: any[];
  resourceCount: number;
  exposedToolNames: string[];
}

const DEFAULT_TIMEOUT_SECONDS = 60;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parsePromptArgs(arg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of arg.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue; // best effort: ignore unrecognised tokens
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

export async function connectMcpServers(servers: Record<string, McpServerConfig>, ui: Ui): Promise<McpHandle> {
  const names = Object.keys(servers);
  const clients = new Map<string, McpClient>();
  for (const name of names) {
    const cfg = { ...servers[name], timeoutSeconds: servers[name].timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS };
    clients.set(name, new McpClient(name, cfg));
  }

  const results = await Promise.allSettled(
    names.map(async (name): Promise<ServerState> => {
      const client = clients.get(name)!;
      await client.connect();
      const [tools, prompts, resources] = await Promise.all([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
      ]);
      return { client, tools, prompts, resourceCount: resources.length, exposedToolNames: [] };
    }),
  );

  const connected: { name: string; state: ServerState }[] = [];
  results.forEach((r, i) => {
    const name = names[i];
    if (r.status === "fulfilled") {
      connected.push({ name, state: r.value });
    } else {
      ui.warn(`MCP server "${name}" unavailable: ${errorText(r.reason)}`);
      clients.get(name)?.stop();
      clients.delete(name);
    }
  });

  const tools: ToolDef[] = [];
  const commands: Command[] = [];

  for (const { name, state } of connected) {
    const allow = servers[name].allowTools;
    for (const tool of state.tools) {
      if (allow && !allow.includes(tool.name)) continue;
      const exposed = `mcp__${name}__${tool.name}`;
      state.exposedToolNames.push(tool.name);
      tools.push({
        name: exposed,
        description: `[${name}] ${tool.description ?? tool.name}`,
        kind: tool.annotations?.readOnlyHint === true ? "read" : "exec",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
        subject: (args: any) => JSON.stringify(args).slice(0, 200),
        run: async (args: any) => state.client.callTool(tool.name, args),
      });
    }

    for (const prompt of state.prompts) {
      commands.push({
        name: `${name}:${prompt.name}`,
        help: prompt.description ?? "MCP prompt",
        run: async (arg: string) => ({
          send: await state.client.getPrompt(prompt.name, parsePromptArgs(arg)),
        }),
      });
    }
  }

  const withResources = connected.filter(({ state }) => state.resourceCount > 0);
  if (withResources.length > 0) {
    tools.push({
      name: "mcp_read_resource",
      description: "Read a resource exposed by a connected MCP server.",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          uri: { type: "string", description: "Resource URI" },
        },
        required: ["server", "uri"],
      },
      subject: (args: any) => `${args?.server ?? "?"} ${args?.uri ?? ""}`,
      run: async (args: any) => {
        const server = String(args?.server ?? "");
        const entry = connected.find((c) => c.name === server);
        if (!entry) throw new Error(`no connected MCP server named "${server}"`);
        return entry.state.client.readResource(String(args?.uri ?? ""));
      },
    });
  }

  const summary = (): string => {
    if (connected.length === 0) return "No MCP servers connected.";
    return connected
      .map(({ name, state }) => {
        const toolList = state.exposedToolNames.join(", ") || "no tools";
        return `${name}: ${toolList} (${state.prompts.length} prompts, ${state.resourceCount} resources)`;
      })
      .join("\n");
  };

  const stop = (): void => {
    for (const client of clients.values()) client.stop();
  };

  return { clients, tools, commands, summary, stop };
}
