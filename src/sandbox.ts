import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "./config";

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
    if (fs.existsSync(candidate)) return candidate;
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

export function sandboxStatus(cfg: Config["sandbox"], platform: NodeJS.Platform = process.platform): SandboxStatus {
  if (cfg.enabled === false) return { backend: null, active: false, reason: "disabled in settings or with --no-sandbox" };
  if (platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    return { backend: "sandbox-exec", active: true, reason: "sandbox-exec" };
  }
  if (platform === "linux" && which("bwrap")) return { backend: "bwrap", active: true, reason: "bubblewrap" };
  const reason = `no sandbox backend on ${platform}`;
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
  const shell = ["/bin/zsh", "-c", command];
  if (!status.active || !status.backend) return { file: shell[0], args: shell.slice(1), sandboxed: false };
  const root = realOrSelf(cwd);
  if (status.backend === "sandbox-exec") {
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", darwinProfile(root, cfg), ...shell],
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
      ...shell,
    ],
    sandboxed: true,
  };
}
