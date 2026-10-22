import type { Config, Prices } from "./config";
import type { Checkpoints } from "./checkpoints";
import type { SandboxStatus } from "./sandbox";
import type { Message, Mode, ModelProvider, JsonSchema, ToolKind, Ui, Usage } from "./types";

export interface Session {
  id: string;
  history: Message[];
  todos: string[];
  usage: Usage;
  denials: number;
}

export interface ToolCallInfo {
  explicitAllow: boolean;
}

export interface PreflightStop {
  message: string;
  denied: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  kind: ToolKind;
  parameters: JsonSchema;
  subject?: (args: any) => string;
  shellCommand?: (args: any) => string | undefined;
  preview?: (args: any, rt: Runtime) => Promise<{ title: string; body: string } | null>;
  preflight?: (args: any, rt: Runtime) => Promise<PreflightStop | null>;
  run: (args: any, rt: Runtime, call: ToolCallInfo) => Promise<string>;
}

export interface Runtime {
  cwd: string;
  config: Config;
  state: { mode: Mode; model: string };
  provider: ModelProvider;
  ui: Ui;
  session: Session;
  checkpoints: Checkpoints;
  sandbox: SandboxStatus;
  tools: ToolDef[];
  allowedTools: Set<string> | null;
  depth: number;
  signal?: AbortSignal;
  editedThisTurn: boolean;
  budget: { maxSteps?: number; maxCostUsd?: number; price?: Prices };
  runSubagent?: (prompt: string, allowed: Set<string>) => Promise<string>;
}

export function newSession(id: string): Session {
  return { id, history: [], todos: [], usage: { input: 0, output: 0 }, denials: 0 };
}

export function costOf(usage: { input: number; output: number }, price: Prices | undefined): number {
  if (!price) return 0;
  return (usage.input * price.inputPerMTok + usage.output * price.outputPerMTok) / 1_000_000;
}
