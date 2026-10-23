import { compactHistory, estimateTokens } from "../context";
import { listSessions, loadSession, saveSession, autoSessionName, validateSessionName } from "../session";
import { sandboxStatus } from "../sandbox";
import type { Runtime } from "../runtime";
import type { Mode } from "../types";

export type CommandResult = string | { send: string; allowedTools?: string[] };

export interface CommandEnv {
  rt: Runtime;
  allowAuto: boolean;
  mcpSummary: () => string;
}

export interface Command {
  name: string;
  help: string;
  run: (arg: string, env: CommandEnv) => Promise<CommandResult> | CommandResult;
}

const MODES: Mode[] = ["regular", "plan", "auto"];

function fmtError(e: unknown): string {
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}

export function builtinCommands(): Command[] {
  return [
    {
      name: "model",
      help: "Show or set the model: /model [name]",
      run: (arg, { rt }) => {
        const name = arg.trim();
        if (!name) return `model: ${rt.state.model}`;
        rt.state.model = name;
        return `model set to ${name}`;
      },
    },
    {
      name: "mode",
      help: "Show or set the mode: /mode [regular|plan|auto]",
      run: (arg, { rt, allowAuto }) => {
        const m = arg.trim();
        if (!m) return `mode: ${rt.state.mode}`;
        if (!MODES.includes(m as Mode)) return "Error: mode must be regular, plan, or auto";
        if (m === "auto" && !allowAuto) return "Error: auto mode approves every action. Start opencli with --allow-auto to enable it.";
        rt.state.mode = m as Mode;
        return `mode set to ${m}`;
      },
    },
    {
      name: "context",
      help: "Show conversation context and token estimate",
      run: (_arg, { rt }) => {
        const lines = rt.session.history.map((m) => `${m.role}: ${(m.content ?? "").replace(/\n/g, " ").slice(0, 80)}`);
        return `${lines.join("\n")}\n~${estimateTokens(rt.session.history)} tokens of ${rt.config.contextWindow}`;
      },
    },
    {
      name: "usage",
      help: "Show token usage for this session",
      run: (_arg, { rt }) => {
        const { input, output } = rt.session.usage;
        const price = rt.config.prices[rt.state.model];
        const cost = price ? `  est. $${((input * price.inputPerMTok + output * price.outputPerMTok) / 1_000_000).toFixed(4)}` : "";
        return `input ${input} tokens, output ${output} tokens${cost}`;
      },
    },
    {
      name: "compact",
      help: "Summarise and compress the conversation",
      run: async (_arg, { rt }) => {
        try {
          const done = await compactHistory(rt.provider, rt.state.model, rt.session.history, rt.signal);
          return done ? `compacted: ${done.removed} messages -> 1` : "Nothing to compact.";
        } catch (e) {
          return fmtError(e);
        }
      },
    },
    {
      name: "undo",
      help: "Revert the files changed by the last turn",
      run: (_arg, { rt }) => {
        const restored = rt.checkpoints.undo();
        if (!restored) return "Nothing to undo.";
        return `Reverted ${restored.length} file(s):\n${restored.join("\n")}`;
      },
    },
    {
      name: "todos",
      help: "Show the current todo list",
      run: (_arg, { rt }) => rt.session.todos.map((t, i) => `${i + 1}. ${t}`).join("\n") || "No todos.",
    },
    {
      name: "save",
      help: "Save this session: /save <name>",
      run: (arg, { rt }) => {
        try {
          const name = validateSessionName(arg);
          saveSession(name, { model: rt.state.model, mode: rt.state.mode, cwd: rt.cwd, messages: rt.session.history.slice(1) });
          return `saved ${name}`;
        } catch (e) {
          return fmtError(e);
        }
      },
    },
    {
      name: "load",
      help: "Load a saved session: /load <name>",
      run: (arg, { rt }) => {
        try {
          const data = loadSession(arg);
          rt.session.history.splice(1, rt.session.history.length - 1, ...data.messages);
          rt.state.model = data.model;
          return `loaded ${arg.trim()} (${data.messages.length} messages)`;
        } catch (e) {
          return fmtError(e);
        }
      },
    },
    {
      name: "sessions",
      help: "List saved sessions",
      run: (_arg, _env) => {
        const names = listSessions();
        return names.length ? names.join("\n") : "No saved sessions.";
      },
    },
    {
      name: "reset",
      help: "Clear the conversation",
      run: (_arg, { rt }) => {
        rt.session.history.splice(1);
        rt.session.todos = [];
        return "History cleared.";
      },
    },
    {
      name: "mcp",
      help: "List connected MCP servers and their tools",
      run: (_arg, { mcpSummary }) => mcpSummary(),
    },
    {
      name: "sandbox",
      help: "Show whether shell commands are sandboxed",
      run: (_arg, { rt }) => {
        const s = rt.sandbox;
        const writable = [rt.cwd, ...rt.config.sandbox.writable].join(", ");
        return `${s.active ? `on (${s.backend})` : `off (${s.reason})`}\nnetwork: ${rt.config.sandbox.network ? "allowed" : "denied"}\nwritable: ${writable}`;
      },
    },
    {
      name: "tools",
      help: "List available tools",
      run: (_arg, { rt }) => rt.tools.map((t) => `${t.name} (${t.kind})`).join("\n"),
    },
  ];
}

export function findCommand(name: string, commands: Command[]): Command | undefined {
  return commands.find((c) => c.name === name);
}

export function helpText(commands: Command[]): string {
  const lines = commands.map((c) => `  /${c.name.padEnd(12)}${c.help}`);
  return [
    "Commands:",
    ...lines,
    "  /paste       Multi-line paste mode (end with . alone on a line)",
    "  /exit        Quit",
    "",
    "Multi-line: end a line with \\ to continue on the next line.",
    "Mention files with @./path or @/abs/path to include their contents.",
  ].join("\n");
}

export { autoSessionName };
