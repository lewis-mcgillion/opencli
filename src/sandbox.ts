import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { Config } from "./config";
import { shellCommand } from "./system-shell";

export interface CommandPlan {
  file: string;
  args: string[];
  sandboxed: boolean;
}

export interface SandboxStatus {
  backend: "sandbox-exec" | "bwrap" | null;
  active: boolean;
  reason: string;
}

function which(bin: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing or non-executable PATH entries are not usable backends.
    }
  }
  return null;
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function quoteProfile(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export interface SandboxChecks {
  exists: (file: string) => boolean;
  findExecutable: (name: string) => string | null;
  probeBubblewrap: (file: string, cfg: Config["sandbox"]) => string | null;
}

function probeBubblewrap(file: string, cfg: Config["sandbox"]): string | null {
  // A binary on PATH does not guarantee that user/network namespaces are permitted.
  const plan = planCommand("true", process.cwd(), cfg, { backend: "bwrap", active: true, reason: "probe" });
  const result = spawnSync(file, plan.args, { encoding: "utf8", timeout: 3000, maxBuffer: 16_384 });
  if (result.status === 0 && !result.error) return null;
  return (result.error?.message || result.stderr.trim() || `probe exited ${result.status ?? result.signal ?? "unknown"}`).slice(0, 500);
}

export function sandboxStatus(
  cfg: Config["sandbox"],
  platform: NodeJS.Platform = process.platform,
  checks: Partial<SandboxChecks> = {},
): SandboxStatus {
  if (cfg.enabled === false) return { backend: null, active: false, reason: "disabled in settings or with --no-sandbox" };
  if (platform === "darwin" && (checks.exists ?? fs.existsSync)("/usr/bin/sandbox-exec")) {
    return { backend: "sandbox-exec", active: true, reason: "sandbox-exec" };
  }
  let reason = `no sandbox backend on ${platform}`;
  if (platform === "linux") {
    const file = (checks.findExecutable ?? which)("bwrap");
    if (file) {
      const failure = (checks.probeBubblewrap ?? probeBubblewrap)(file, cfg);
      if (failure === null) return { backend: "bwrap", active: true, reason: "bubblewrap (experimental; startup probe passed)" };
      reason = `Linux sandbox unavailable: bubblewrap startup probe failed (${failure})`;
    } else {
      reason = "Linux sandbox unavailable: executable bwrap not found on PATH";
    }
  }
  return cfg.enabled === true
    ? { backend: null, active: false, reason: `${reason}; sandbox was required` }
    : { backend: null, active: false, reason };
}

function darwinProfile(cwd: string, cfg: Config["sandbox"]): string {
  const writable = [
    cwd,
    os.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/private/var/folders",
    "/dev",
    ...cfg.writable,
  ].map((p) => quoteProfile(realOrSelf(p)));
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((w) => `(subpath ${w})`).join(" ")})`,
  ];
  if (!cfg.network) lines.push("(deny network-outbound)");
  return lines.join("\n");
}

export function planCommand(command: string, cwd: string, cfg: Config["sandbox"], status: SandboxStatus): CommandPlan {
  const [shellFile, shellArgs] = shellCommand(command);
  if (!status.active || !status.backend) return { file: shellFile, args: shellArgs, sandboxed: false };
  const root = realOrSelf(cwd);
  if (status.backend === "sandbox-exec") {
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", darwinProfile(root, cfg), shellFile, ...shellArgs],
      sandboxed: true,
    };
  }
  const binds = [root, os.tmpdir(), ...cfg.writable].flatMap((p) => ["--bind", realOrSelf(p), realOrSelf(p)]);
  return {
    file: "bwrap",
    args: [
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      ...binds,
      ...(cfg.network ? [] : ["--unshare-net"]),
      "--die-with-parent",
      "--chdir", root,
      shellFile,
      ...shellArgs,
    ],
    sandboxed: true,
  };
}
