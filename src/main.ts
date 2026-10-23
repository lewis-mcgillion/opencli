import * as fs from "node:fs";
import * as readline from "node:readline";
import { createApp, newSessionId } from "./app";
import { expandMentions, submitMessage } from "./chat";
import { loadConfig, projectFingerprintFor, trustProject, type Config } from "./config";
import { executeTool } from "./execute";
import { stopBackgroundJobs } from "./tools/shell";
import { loadSession, autoSessionName } from "./session";
import { costOf } from "./runtime";
import { CollectUi, JsonLinesUi } from "./ui/events";
import { runRepl } from "./ui/repl";
import { TextUi, ansi } from "./ui/text";
import { TuiUi, runTui } from "./ui/tui";
import type { Mode, OutputFormat, Ui } from "./types";
import type { TurnResult } from "./agent";
import type { App } from "./app";
import { createProvider } from "./model";
import { findModelProfile, resolveProfileConfig, renderProfiles } from "./model/profiles";

export const VERSION = "0.3.0";

const BOOLEAN_FLAGS = new Set(["print", "no-sandbox", "no-repo-map", "continue", "allow-auto", "version", "help", "show-system", "show-config"]);
const VALUE_FLAGS = new Set(["mode", "model", "url", "provider", "output-format", "max-turns", "max-cost", "allowed-tools", "resume", "file", "tool", "expand"]);
const SHORT: Record<string, string> = { p: "print", c: "continue", h: "help", v: "version" };

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (literal) { positional.push(arg); continue; }
    if (arg === "--") { literal = true; continue; }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) {
        const value = argv[++i];
        if (value === undefined) throw new Error(`--${name} needs a value`);
        flags[name] = value;
      } else throw new Error(`unknown option --${name}`);
      continue;
    }
    if (arg.startsWith("-") && arg.length === 2 && SHORT[arg[1]]) {
      flags[SHORT[arg[1]]] = true;
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

const USAGE = `opencli ${VERSION} - terminal coding agent

Usage:
  opencli                        interactive UI (TUI on a terminal)
  opencli [options] "prompt"     run one task and exit
  echo "prompt" | opencli -p     read the task from stdin
  opencli models list            list built-in and custom profiles
  opencli models show <profile>  show profile metadata as JSON
  opencli models test <profile>  test a profile with the resolved config

Options:
  -p, --print                    non-interactive run
  --output-format <fmt>          text (default), json, stream-json
  --mode <regular|plan|auto>     permission mode (default regular)
  --allow-auto                   allow auto mode
  --model <name>                 model to use
  --url <url>                    OpenAI- or Anthropic-compatible base URL
  --provider <openai|anthropic|azure>
                                  API flavour
  --max-turns <n>                steps per task (default 40)
  --max-cost <usd>               stop when estimated cost reaches this (needs prices in config)
  --allowed-tools <a,b>          restrict tools for this run
  --file <path>                  read the task from a file
  -c, --continue                 resume the last session in this directory
  --resume <name>                resume a saved session
  --no-sandbox                   run shell commands without the sandbox
  --no-repo-map                  leave the repository map out of the prompt
  --show-system | --show-config  print the system prompt or resolved config
  --tool <name> [json]           run one tool directly
  --expand <text>                print text with @file mentions expanded
  -v, --version | -h, --help

Exit codes (print mode): 0 done, 1 error, 2 turn or cost limit reached, 3 done but a permission was denied.`;

function exitWith(code: number): never {
  process.exit(code);
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function lastAssistantText(history: App["rt"]["session"]["history"]): string {
  const last = [...history].reverse().find((m) => m.role === "assistant");
  return last?.content ?? "";
}

async function resolvePrompt(flags: Record<string, string | boolean>, positional: string[]): Promise<string | null> {
  if (typeof flags.file === "string") return fs.readFileSync(flags.file, "utf-8");
  if (positional.length) return positional.join(" ");
  if (!process.stdin.isTTY) {
    const text = fs.readFileSync(0, "utf-8");
    return text.trim() ? text : null;
  }
  return null;
}

async function runHeadless(app: App, ui: Ui, prompt: string, format: OutputFormat, maxCostUsd: number | undefined): Promise<number> {
  const { rt } = app;
  let result: TurnResult | null = null;
  let error: string | null = null;
  try {
    result = await submitMessage(rt, prompt);
  } catch (e: any) {
    error = e?.message ?? String(e);
  }

  const price = rt.config.prices[rt.state.model];
  const costUsd = price ? costOf(rt.session.usage, price) : null;
  let subtype = "success";
  let exitCode = 0;
  let isError = false;
  if (error || result?.status === "cancelled" || !result) {
    subtype = "error";
    isError = true;
    exitCode = 1;
  } else if (result.status === "max_steps") {
    subtype = "error_max_turns";
    exitCode = 2;
  } else if (result.status === "budget") {
    subtype = "error_max_budget_usd";
    exitCode = 2;
  } else if (rt.session.denials > 0) {
    exitCode = 3;
  }
  if (maxCostUsd !== undefined && costUsd === null && !error) {
    rt.ui.warn("[--max-cost ignored: no prices configured for this model]");
  }

  const payload = {
    subtype,
    is_error: isError,
    result: error ?? lastAssistantText(rt.session.history),
    num_turns: result?.steps ?? 0,
    usage: { input_tokens: rt.session.usage.input, output_tokens: rt.session.usage.output },
    total_cost_usd: costUsd,
    denials: rt.session.denials,
    session: rt.session.id,
  };
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ type: "result", ...payload }, null, 2)}\n`);
  } else if (format === "stream-json" && ui instanceof JsonLinesUi) {
    ui.result(payload);
  } else if (format === "text" && isError) {
    process.stderr.write(`${ansi.red(`Error: ${payload.result}`)}\n`);
  }
  return exitCode;
}

function interactiveUi(useTui: boolean): { ui: Ui; tui?: TuiUi } {
  if (useTui) {
    const tui = new TuiUi();
    return { ui: tui, tui };
  }
  return { ui: new TextUi({ out: (s) => process.stdout.write(s), err: (s) => process.stdout.write(s), color: true }) };
}

async function main(): Promise<number> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "models") return await runModelsCommand(rawArgs.slice(1));
  const { flags, positional } = parseArgs(rawArgs);
  if (flags.version) { console.log(VERSION); return 0; }
  if (flags.help) { console.log(USAGE); return 0; }
  if (typeof flags.expand === "string") {
    console.log(expandMentions(flags.expand, process.cwd()));
    return 0;
  }

  const cwd = process.cwd();
  const interactiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let config: Config = loadConfig({ cwd, env: process.env });
  if (config.projectTrustNeeded) {
    if (interactiveTerminal && (await confirm(`This project defines MCP servers, hooks, permissions, sandbox settings or a verify command (${cwd}/.opencli or .llmcli). Trust them?`))) {
      trustProject(cwd, projectFingerprintFor(cwd));
      config = loadConfig({ cwd, env: process.env, trustProject: true });
    } else {
      process.stderr.write("[project settings ignored: run interactively once to trust them]\n");
    }
  }

  if (typeof flags.model === "string") config.model = flags.model;
  if (typeof flags.url === "string") config.url = flags.url;
  if (typeof flags.provider === "string") {
    if (flags.provider !== "openai" && flags.provider !== "anthropic" && flags.provider !== "azure") throw new Error("--provider must be openai, anthropic or azure");
    config.provider = flags.provider as Config["provider"];
  }
  if (flags["no-sandbox"]) config.sandbox = { ...config.sandbox, enabled: false };
  if (flags["no-repo-map"]) config.repoMap = false;

  if (flags["show-config"]) {
    const { apiKey: _key, ...shown } = config;
    console.log(JSON.stringify(shown, null, 2));
    return 0;
  }

  const mode = (typeof flags.mode === "string" ? flags.mode : "regular") as Mode;
  if (!["regular", "plan", "auto"].includes(mode)) throw new Error("--mode must be regular, plan or auto");
  if (mode === "auto" && !flags["allow-auto"]) throw new Error("auto mode approves every action; add --allow-auto to enable it");
  const format = (typeof flags["output-format"] === "string" ? flags["output-format"] : "text") as OutputFormat;
  if (!["text", "json", "stream-json"].includes(format)) throw new Error("--output-format must be text, json or stream-json");
  const maxSteps = typeof flags["max-turns"] === "string" ? Number(flags["max-turns"]) : undefined;
  const maxCostUsd = typeof flags["max-cost"] === "string" ? Number(flags["max-cost"]) : undefined;
  const allowedTools = typeof flags["allowed-tools"] === "string" ? flags["allowed-tools"].split(",").map((s) => s.trim()).filter(Boolean) : null;

  if (typeof flags.tool === "string") {
    const ui = new TextUi({ out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), color: false });
    const app = await createApp({ config, cwd, ui, mode, allowAuto: Boolean(flags["allow-auto"]), allowedTools: null, sessionId: newSessionId() });
    const result = await executeTool(app.rt, flags.tool, positional[0] ?? "{}");
    console.log(result.output);
    app.mcp.stop();
    return result.isError ? 1 : 0;
  }

  const prompt = await resolvePrompt(flags, positional);
  if (flags.print && prompt === null) throw new Error("print mode needs a prompt: pass it as an argument, with --file, or on stdin");
  const headless = prompt !== null || Boolean(flags.print);

  if (flags["show-system"]) {
    const app = await createApp({ config, cwd, ui: interactiveUi(false).ui, mode, allowAuto: false, allowedTools: null, sessionId: newSessionId() });
    console.log(app.rt.session.history[0].content ?? "");
    app.mcp.stop();
    return 0;
  }

  let ui: Ui;
  let tui: TuiUi | undefined;
  if (headless) {
    if (format === "json") ui = new CollectUi((s) => process.stderr.write(s));
    else if (format === "stream-json") ui = new JsonLinesUi((s) => process.stdout.write(s));
    else ui = new TextUi({ out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), color: Boolean(process.stdout.isTTY) });
  } else {
    ({ ui, tui } = interactiveUi(Boolean(config.tui && interactiveTerminal)));
  }

  const sessionId = typeof flags.resume === "string" ? flags.resume : newSessionId();
  const app = await createApp({ config, cwd, ui, mode, allowAuto: Boolean(flags["allow-auto"]), allowedTools, maxSteps, maxCostUsd, sessionId });
  const restoreName = typeof flags.resume === "string" ? flags.resume : flags.continue ? autoSessionName(cwd) : null;
  if (restoreName) {
    try {
      const saved = loadSession(restoreName);
      app.rt.session.history.splice(1, app.rt.session.history.length - 1, ...saved.messages);
      app.rt.state.model = saved.model;
    } catch (e) {
      if (typeof flags.resume === "string") throw e;
    }
  }

  const stop = () => {
    stopBackgroundJobs();
    app.mcp.stop();
  };

  if (headless) {
    const code = await runHeadless(app, ui, prompt ?? "", format, maxCostUsd);
    stop();
    return code;
  }

  if (tui) {
    runTui(app, tui, config.model);
  } else {
    runRepl(app, { modelLabel: app.rt.state.model });
  }
  return -1;
}

async function runModelsCommand(args: string[]): Promise<number> {
  const sub = args[0] ?? "list";
  if (!["list", "show", "test"].includes(sub)) throw new Error("models command must be list, show or test");
  const base = loadConfig({ cwd: process.cwd(), env: process.env });
  if (sub === "list") {
    console.log(renderProfiles(base.modelProfiles));
    return 0;
  }
  const profileId = args[1];
  if (!profileId) throw new Error(`models ${sub} needs a profile id`);
  const profile = findModelProfile(profileId, base.modelProfiles);
  if (!profile) throw new Error(`unknown model profile ${profileId}`);
  if (sub === "show") {
    console.log(JSON.stringify(profile, null, 2));
    return 0;
  }
  const config = resolveProfileConfig(base, profile, process.env);
  const result = await createProvider(config).chat({
    model: config.model,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    tools: [],
  });
  console.log(`${profile.id}: ${result.message.content?.trim() || "ok"}`);
  return 0;

}

main()
  .then((code) => {
    if (code >= 0) process.exitCode = code;
  })
  .catch((e) => {
    process.stderr.write(`${ansi.red(`opencli: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    exitWith(1);
  });
