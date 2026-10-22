import * as crypto from "node:crypto";
import type { Config } from "./config";
import { buildSystemPrompt } from "./prompt";
import { buildRepoMap } from "./repomap";
import { sandboxStatus } from "./sandbox";
import { createProvider } from "./model";
import { Checkpoints } from "./checkpoints";
import { connectMcpServers, type McpHandle } from "./mcp/manager";
import { builtinCommands, type Command, type CommandEnv } from "./commands/index";
import { loadCustomCommands } from "./commands/custom";
import { fileTools } from "./tools/files";
import { shellTools } from "./tools/shell";
import { searchTools } from "./tools/search";
import { webTools } from "./tools/web";
import { planningTools } from "./tools/planning";
import { runSubagent } from "./agent";
import { costOf, newSession, type Runtime, type ToolDef } from "./runtime";
import type { Mode, Ui } from "./types";

export interface AppOptions {
  config: Config;
  cwd: string;
  ui: Ui;
  mode: Mode;
  allowAuto: boolean;
  allowedTools: string[] | null;
  maxSteps?: number;
  maxCostUsd?: number;
  sessionId: string;
}

export interface App {
  rt: Runtime;
  commands: Command[];
  env: CommandEnv;
  mcp: McpHandle;
}

export async function createApp(opts: AppOptions): Promise<App> {
  const { config, cwd, ui } = opts;
  const sandbox = sandboxStatus(config.sandbox);
  const mcp = await connectMcpServers(config.mcpServers, ui);
  const repoMap = config.repoMap ? buildRepoMap(cwd) : undefined;
  const sandboxNote = sandbox.active
    ? `sandboxed (${sandbox.backend}); writes are limited to the project and temp directories${config.sandbox.network ? "" : ", and network access is blocked"}`
    : `not sandboxed (${sandbox.reason}); commands that change files or run code need approval`;
  const systemPrompt = buildSystemPrompt({ cwd, sandboxNote, repoMap });

  const tools: ToolDef[] = [...fileTools, ...shellTools, ...searchTools, ...webTools, ...planningTools, ...mcp.tools];
  const session = newSession(opts.sessionId);
  session.history.push({ role: "system", content: systemPrompt });

  const rt: Runtime = {
    cwd,
    config,
    state: { mode: opts.mode, model: config.model },
    provider: createProvider(config),
    ui,
    session,
    checkpoints: new Checkpoints(),
    sandbox,
    tools,
    allowedTools: opts.allowedTools ? new Set(opts.allowedTools) : null,
    depth: 0,
    editedThisTurn: false,
    budget: { maxSteps: opts.maxSteps, maxCostUsd: opts.maxCostUsd, price: config.prices[config.model] },
  };
  rt.runSubagent = (prompt, allowed) => runSubagent(rt, prompt, allowed);

  const builtins = builtinCommands();
  const commands = [
    ...builtins,
    ...loadCustomCommands(cwd, new Set(builtins.map((c) => c.name))),
    ...mcp.commands,
  ];
  const env: CommandEnv = { rt, allowAuto: opts.allowAuto, mcpSummary: () => mcp.summary() };
  return { rt, commands, env, mcp };
}

export function newSessionId(): string {
  return crypto.randomBytes(6).toString("hex");
}
