import { execFile } from "node:child_process";

const OUTPUT_TAIL = 4000;

export function runVerify(command: string, cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/zsh", ["-c", command], { cwd, timeout: 300_000, maxBuffer: 10_000_000, signal }, (err, stdout, stderr) => {
      const combined = `${stdout}${stderr}`;
      const output = combined.length > OUTPUT_TAIL ? `...${combined.slice(-OUTPUT_TAIL)}` : combined;
      resolve({ ok: !err, output: output || (err ? err.message : "(no output)") });
    });
  });
}
