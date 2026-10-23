import * as fs from "node:fs";
import * as path from "node:path";

const SHELL_NAMES = new Set(["zsh", "bash", "sh"]);

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function commandShell(fromEnv = process.env.SHELL, available = isExecutable): string {
  const candidates = [
    fromEnv && SHELL_NAMES.has(path.basename(fromEnv)) ? fromEnv : null,
    "/bin/zsh",
    "/usr/bin/zsh",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/sh",
    "/usr/bin/sh",
  ].filter((p): p is string => Boolean(p));
  return candidates.find(available) ?? "sh";
}

export function shellCommand(command: string): [string, string[]] {
  return [commandShell(), ["-c", command]];
}
