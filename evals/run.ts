#!/usr/bin/env bun
// opencli eval runner. Runs each task in a fresh temp dir through the agent CLI,
// then checks the files on disk. Usage: bun run evals/run.ts --help
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tasks as allTasks, type EvalTask } from "./tasks.ts";
import { commandShell } from "../src/system-shell.ts";

const EVALS_DIR = import.meta.dir;
const REPO_DIR = path.resolve(EVALS_DIR, "..");
const MAIN_TS = path.join(REPO_DIR, "src", "main.ts");
const RESULTS_ROOT = path.join(EVALS_DIR, "results");

const USAGE = `Usage: bun run evals/run.ts [options]

Runs the opencli eval tasks (evals/tasks.ts) against a model and reports pass rate.

Options:
  --model <name>       Model name (default: gemma4:31b)
  --url <url>          OpenAI-compatible endpoint; passed to the CLI only when given
                       (default: the CLI's own default)
  --provider <p>       openai | anthropic | azure; passed to the CLI only when given
  --filter <substring> Run only task ids containing this substring
  --max-turns <n>      Turn budget per task (default: 40)
  --timeout <seconds>  Wall-clock limit per task (default: 600)
  --out <path>         Full JSON results file (default: evals/results/<timestamp>.json)
  --keep               Keep each task's temp dir for inspection
  --help               Show this help and exit

Per-task agent stderr goes to evals/results/<timestamp>/<id>.log.
Exit code is 0 after a measurement run; 2 for bad arguments.
`;

class UsageError extends Error {}

interface Options {
  model: string;
  url?: string;
  provider?: "openai" | "anthropic" | "azure";
  filter?: string;
  maxTurns: number;
  timeout: number;
  out?: string;
  keep: boolean;
}

interface AgentResult {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  denials?: number;
  session?: string;
}

interface TaskResult {
  id: string;
  category: EvalTask["category"];
  status: "PASS" | "FAIL" | "TIMEOUT";
  passed: boolean;
  reason: string;
  turns: number | null;
  seconds: number;
  exitCode: number | null;
  subtype: string | null;
  isError: boolean | null;
  denials: number | null;
  inputTokens: number;
  outputTokens: number;
  session: string | null;
  logPath: string | null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parsePositive(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number, got "${raw}"`);
  return n;
}

function parseArgs(argv: string[]): Options | "help" {
  const opts: Options = { model: "gemma4:31b", maxTurns: 40, timeout: 600, keep: false };
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--help":
      case "-h":
        return "help";
      case "--model":
        opts.model = take(i, a);
        i++;
        break;
      case "--url":
        opts.url = take(i, a);
        i++;
        break;
      case "--provider": {
        const p = take(i, a);
        if (p !== "openai" && p !== "anthropic" && p !== "azure") throw new UsageError(`--provider must be openai, anthropic or azure`);
        opts.provider = p;
        i++;
        break;
      }
      case "--filter":
        opts.filter = take(i, a);
        i++;
        break;
      case "--max-turns":
        opts.maxTurns = Math.floor(parsePositive(a, take(i, a)));
        i++;
        break;
      case "--timeout":
        opts.timeout = parsePositive(a, take(i, a));
        i++;
        break;
      case "--out":
        opts.out = path.resolve(take(i, a));
        i++;
        break;
      case "--keep":
        opts.keep = true;
        break;
      default:
        throw new UsageError(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function parseAgentResult(stdout: string): AgentResult | undefined {
  const candidates = stdout.split("\n").reverse();
  for (const line of candidates) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as AgentResult;
      if (obj && obj.type === "result") return obj;
    } catch {
      // noise line, keep scanning
    }
  }
  try {
    const obj = JSON.parse(stdout.trim()) as AgentResult;
    if (obj && obj.type === "result") return obj;
  } catch {
    // not a single JSON document
  }
  return undefined;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureResultsRoot(): void {
  if (!fs.existsSync(RESULTS_ROOT)) {
    ensureDir(RESULTS_ROOT);
    fs.writeFileSync(path.join(RESULTS_ROOT, ".gitignore"), "*\n!.gitignore\n");
  }
}

function writeTaskFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (!abs.startsWith(dir + path.sep)) throw new Error(`task file escapes temp dir: ${rel}`);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, content);
  }
}

async function runSetup(command: string, dir: string): Promise<{ ok: boolean; reason: string }> {
  const proc = Bun.spawn([commandShell(), "-c", command], { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code === 0) return { ok: true, reason: "" };
  return { ok: false, reason: `setup failed (exit ${code}): ${stderr.trim().slice(0, 200)}` };
}

async function runTask(task: EvalTask, opts: Options, logDir: string, keep: boolean): Promise<TaskResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencli-eval-"));
  const logPath = path.join(logDir, `${task.id}.log`);
  const base: TaskResult = {
    id: task.id,
    category: task.category,
    status: "FAIL",
    passed: false,
    reason: "",
    turns: null,
    seconds: 0,
    exitCode: null,
    subtype: null,
    isError: null,
    denials: null,
    inputTokens: 0,
    outputTokens: 0,
    session: null,
    logPath,
  };
  const started = performance.now();
  try {
    writeTaskFiles(dir, task.files);

    if (task.setup) {
      const setup = await runSetup(task.setup, dir);
      if (!setup.ok) {
        base.reason = setup.reason;
        return base;
      }
    }

    const args = [
      process.execPath, "run", MAIN_TS,
      "--print", "--output-format", "json",
      "--mode", "auto", "--allow-auto",
      "--model", opts.model,
      "--max-turns", String(opts.maxTurns),
      "--no-sandbox",
    ];
    if (opts.url) args.push("--url", opts.url);
    if (opts.provider) args.push("--provider", opts.provider);
    args.push("--", task.prompt);

    const logFd = fs.openSync(logPath, "w");
    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: logFd, env: process.env });
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        killer = setTimeout(() => proc.kill(9), 5000);
      }, opts.timeout * 1000);
      const stdoutP = new Response(proc.stdout as ReadableStream).text();
      const exitCode = await proc.exited;
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      const stdout = await stdoutP;
      base.exitCode = exitCode;
      base.seconds = (performance.now() - started) / 1000;
      const result = parseAgentResult(stdout);
      if (result) {
        base.turns = typeof result.num_turns === "number" ? result.num_turns : null;
        base.subtype = result.subtype ?? null;
        base.isError = typeof result.is_error === "boolean" ? result.is_error : null;
        base.denials = typeof result.denials === "number" ? result.denials : null;
        base.inputTokens = result.usage?.input_tokens ?? 0;
        base.outputTokens = result.usage?.output_tokens ?? 0;
        base.session = result.session ?? null;
      }
      const agentNote = `exit ${exitCode}, ${result ? `subtype ${base.subtype ?? "?"}` : "no result JSON"}`;

      if (timedOut) {
        base.status = "TIMEOUT";
        base.reason = `timed out after ${opts.timeout}s`;
        return base;
      }

      try {
        base.passed = Boolean(await task.check(dir));
      } catch (e) {
        base.passed = false;
        base.reason = `check threw: ${errMsg(e)}`;
      }
      if (base.passed) {
        base.status = "PASS";
      } else {
        base.status = "FAIL";
        if (!base.reason) base.reason = `check failed (${agentNote})`;
      }
      return base;
    } finally {
      fs.closeSync(logFd);
    }
  } catch (e) {
    base.reason = `runner error: ${errMsg(e)}`;
    return base;
  } finally {
    base.seconds = (performance.now() - started) / 1000;
    if (keep) {
      console.log(`  kept temp dir: ${dir}`);
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatLine(r: TaskResult): string {
  const turns = r.turns === null ? "-" : String(r.turns);
  return `${r.status.padEnd(8)}${r.id.padEnd(30)}${turns.padStart(5)}  ${r.seconds.toFixed(1).padStart(7)}s  ${r.reason}`;
}

async function main(): Promise<void> {
  let parsed: Options | "help";
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n`);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (parsed === "help") {
    console.log(USAGE);
    return;
  }
  const opts = parsed;

  const seen = new Set<string>();
  for (const t of allTasks) {
    if (seen.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
    seen.add(t.id);
  }
  const selected = allTasks.filter((t) => !opts.filter || t.id.includes(opts.filter));
  if (selected.length === 0) {
    console.log(`no tasks match filter "${opts.filter ?? ""}"`);
    return;
  }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  ensureResultsRoot();
  const logDir = path.join(RESULTS_ROOT, stamp);
  ensureDir(logDir);
  const outPath = opts.out ?? path.join(RESULTS_ROOT, `${stamp}.json`);
  ensureDir(path.dirname(outPath));

  console.log(`model=${opts.model}${opts.url ? ` url=${opts.url}` : ""}${opts.provider ? ` provider=${opts.provider}` : ""} max-turns=${opts.maxTurns} timeout=${opts.timeout}s tasks=${selected.length}`);
  console.log(`logs: ${logDir}`);

  const results: TaskResult[] = [];
  for (const task of selected) {
    const r = await runTask(task, opts, logDir, opts.keep);
    results.push(r);
    console.log(formatLine(r));
  }

  const passCount = results.filter((r) => r.passed).length;
  const total = results.length;
  const rate = total ? (passCount / total) * 100 : 0;
  const turnValues = results.map((r) => r.turns).filter((t): t is number => t !== null);
  const med = median(turnValues);
  const totalTokens = results.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const summary = {
    passed: passCount,
    total,
    passRatePercent: Number(rate.toFixed(1)),
    medianTurns: med,
    totalTokens,
  };

  console.log("");
  console.log(`pass ${passCount}/${total}  rate ${rate.toFixed(1)}%  median turns ${med === null ? "-" : med}  total tokens ${totalTokens}`);

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: {
      model: opts.model,
      url: opts.url ?? null,
      provider: opts.provider ?? null,
      filter: opts.filter ?? null,
      maxTurns: opts.maxTurns,
      timeoutSeconds: opts.timeout,
    },
    summary,
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`results: ${outPath}`);
}

main().catch((e) => {
  console.error(`runner crashed: ${errMsg(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exitCode = 1;
});
