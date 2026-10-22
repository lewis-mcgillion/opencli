import { execFile, spawn, type ChildProcess } from "node:child_process";
import { planCommand } from "../sandbox";
import type { Runtime, ToolDef } from "../runtime";

const MAX_BUFFER = 10_000_000;
const JOB_OUTPUT_LIMIT = 200_000;

interface Job {
  id: string;
  command: string;
  proc: ChildProcess;
  output: string;
  readUpTo: number;
  exitCode: number | null;
}

const jobs = new Map<string, Job>();
let nextJobId = 1;

export function stopBackgroundJobs(): void {
  for (const job of jobs.values()) {
    if (job.exitCode === null) job.proc.kill("SIGTERM");
  }
}

function sandboxOrFail(command: string, rt: Runtime) {
  const plan = planCommand(command, rt.cwd, rt.config.sandbox, rt.sandbox);
  if (rt.config.sandbox.enabled === true && !plan.sandboxed) {
    throw new Error(`sandbox is required but unavailable (${rt.sandbox.reason})`);
  }
  return plan;
}

function formatResult(err: any, stdout: string, stderr: string): string {
  if (!err) {
    const body = [stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n");
    return body || "(no output)";
  }
  const timedOut = err.killed ? " (timed out)" : "";
  return `Exit ${err.code ?? "?"}${timedOut}\n${stdout}\n[stderr]\n${stderr || err.message}`;
}

function runForeground(command: string, rt: Runtime, timeoutMs: number): Promise<string> {
  const plan = sandboxOrFail(command, rt);
  return new Promise((resolve) => {
    execFile(plan.file, plan.args, { cwd: rt.cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, signal: rt.signal }, (err, stdout, stderr) => {
      resolve(formatResult(err, String(stdout), String(stderr)));
    });
  });
}

function startBackground(command: string, rt: Runtime): string {
  const plan = sandboxOrFail(command, rt);
  const id = `job-${nextJobId++}`;
  const proc = spawn(plan.file, plan.args, { cwd: rt.cwd, stdio: ["ignore", "pipe", "pipe"] });
  const job: Job = { id, command, proc, output: "", readUpTo: 0, exitCode: null };
  const append = (chunk: Buffer) => {
    job.output = (job.output + chunk.toString()).slice(-JOB_OUTPUT_LIMIT);
    job.readUpTo = Math.min(job.readUpTo, job.output.length);
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  proc.on("close", (code) => { job.exitCode = code ?? -1; });
  proc.on("error", (e) => { job.output += `\n[error] ${e.message}`; job.exitCode = -1; });
  jobs.set(id, job);
  return `Started ${id}: ${command}`;
}

const commandPreview = async (args: any) => ({ title: "Command", body: String(args.command ?? args.args ?? "") });

export const shellTools: ToolDef[] = [
  {
    name: "run_bash",
    description: "Run a shell command in the project directory. Returns stdout and stderr. Set background to true for long-running commands, then read them with bash_output.",
    kind: "exec",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command" },
        timeout_seconds: { type: "number", description: "Timeout in seconds (default 30)" },
        background: { type: "boolean", description: "Run without waiting and return a job id" },
      },
      required: ["command"],
    },
    subject: (args) => String(args.command ?? ""),
    shellCommand: (args) => String(args.command ?? ""),
    preview: commandPreview,
    run: async (args, rt) => {
      const command = String(args.command ?? "");
      if (args.background) return startBackground(command, rt);
      return runForeground(command, rt, Number(args.timeout_seconds ?? 30) * 1000);
    },
  },
  {
    name: "git",
    description: "Run a git command in the project directory. args is the argument string after 'git'.",
    kind: "exec",
    parameters: {
      type: "object",
      properties: { args: { type: "string", description: "Arguments to pass to git" } },
      required: ["args"],
    },
    subject: (args) => `git ${String(args.args ?? "")}`,
    shellCommand: (args) => `git ${String(args.args ?? "")}`,
    preview: async (args) => ({ title: "git", body: `git ${String(args.args ?? "")}` }),
    run: async (args, rt) => runForeground(`git ${String(args.args ?? "")}`, rt, 30000),
  },
  {
    name: "bash_output",
    description: "Read new output from a background job started with run_bash.",
    kind: "read",
    parameters: {
      type: "object",
      properties: { job: { type: "string", description: "Job id, for example job-1" } },
      required: ["job"],
    },
    subject: (args) => String(args.job ?? ""),
    run: async (args) => {
      const job = jobs.get(String(args.job));
      if (!job) throw new Error(`no job ${args.job}`);
      const fresh = job.output.slice(job.readUpTo);
      job.readUpTo = job.output.length;
      const status = job.exitCode === null ? "running" : `exited ${job.exitCode}`;
      return `[${job.id}: ${status}]\n${fresh || "(no new output)"}`;
    },
  },
  {
    name: "bash_kill",
    description: "Stop a background job started with run_bash.",
    kind: "exec",
    parameters: {
      type: "object",
      properties: { job: { type: "string", description: "Job id, for example job-1" } },
      required: ["job"],
    },
    subject: (args) => `stop ${String(args.job ?? "")}`,
    run: async (args) => {
      const job = jobs.get(String(args.job));
      if (!job) throw new Error(`no job ${args.job}`);
      if (job.exitCode === null) job.proc.kill("SIGTERM");
      return `Stopped ${job.id}`;
    },
  },
];
