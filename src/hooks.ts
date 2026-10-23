import { spawn } from "node:child_process";
import type { HookSpec } from "./config";
import { shellCommand } from "./system-shell";

export interface HookPayload {
  event: "pre_tool" | "post_tool" | "on_stop";
  tool?: string;
  args?: unknown;
  output?: string;
  is_error?: boolean;
  cwd: string;
}

export interface HookRun {
  code: number;
  stdout: string;
  stderr: string;
}

export function runHook(spec: HookSpec, payload: HookPayload, timeoutMs = 30000): Promise<HookRun> {
  return new Promise((resolve) => {
    const [file, args] = shellCommand(spec.command);
    const child = spawn(file, args, { cwd: payload.cwd, env: { ...process.env, OPENCLI_EVENT: payload.event, LLMCLI_EVENT: payload.event } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: e.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runPreToolHooks(
  specs: HookSpec[],
  payload: HookPayload,
): Promise<{ deny: boolean; message: string }> {
  for (const spec of specs) {
    if (spec.tool && spec.tool !== payload.tool) continue;
    const run = await runHook(spec, payload);
    if (run.code === 2) return { deny: true, message: (run.stderr || run.stdout).trim() || `blocked by pre_tool hook ${spec.command}` };
  }
  return { deny: false, message: "" };
}

export async function runAdvisoryHooks(specs: HookSpec[], payload: HookPayload): Promise<string[]> {
  const notes: string[] = [];
  for (const spec of specs) {
    if (spec.tool && spec.tool !== payload.tool) continue;
    const run = await runHook(spec, payload);
    if (run.code !== 0) notes.push(`hook ${spec.command} exited ${run.code}: ${(run.stderr || run.stdout).trim().slice(0, 200)}`);
  }
  return notes;
}
