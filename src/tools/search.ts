import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvePath } from "./files";
import type { ToolDef } from "../runtime";

const MAX_LINES = 200;

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 10_000_000 }, (_err, stdout) => resolve(String(stdout ?? "")));
  });
}

let rgProbe: Promise<boolean> | null = null;
function hasRg(): Promise<boolean> {
  rgProbe ??= new Promise((resolve) => execFile("rg", ["--version"], (err) => resolve(!err)));
  return rgProbe;
}

const str = (description: string) => ({ type: "string", description });

export const searchTools: ToolDef[] = [
  {
    name: "list_dir",
    description: "List directory contents. Directories are prefixed with d.",
    kind: "read",
    parameters: { type: "object", properties: { path: str("Directory path") }, required: ["path"] },
    subject: (args) => String(args.path ?? ""),
    run: async (args, rt) => {
      const entries = fs.readdirSync(resolvePath(String(args.path), rt.cwd), { withFileTypes: true });
      return entries.map((e) => `${e.isDirectory() ? "d" : "f"}  ${e.name}`).join("\n") || "(empty)";
    },
  },
  {
    name: "glob_files",
    description: "Find files by name pattern, e.g. '*.ts'. Skips node_modules and ignored files.",
    kind: "read",
    parameters: {
      type: "object",
      properties: { pattern: str("Name pattern"), path: str("Directory to search (default .)") },
      required: ["pattern"],
    },
    subject: (args) => String(args.pattern ?? ""),
    run: async (args, rt) => {
      const root = resolvePath(String(args.path ?? "."), rt.cwd);
      const files = (await hasRg())
        ? await run("rg", ["--files", "-g", String(args.pattern), root], rt.cwd)
        : await run("find", [root, "-name", String(args.pattern), "-type", "f", "-not", "-path", "*/node_modules/*"], rt.cwd);
      const lines = files.split("\n").filter(Boolean).map((f) => path.relative(rt.cwd, path.resolve(root, f)) || f);
      return lines.slice(0, MAX_LINES).join("\n") || "(no matches)";
    },
  },
  {
    name: "grep_files",
    description: "Search file contents. Returns matching lines with filenames and line numbers.",
    kind: "read",
    parameters: {
      type: "object",
      properties: { pattern: str("Text or regex"), path: str("File or directory (default .)") },
      required: ["pattern"],
    },
    subject: (args) => String(args.pattern ?? ""),
    run: async (args, rt) => {
      const target = resolvePath(String(args.path ?? "."), rt.cwd);
      const out = (await hasRg())
        ? await run("rg", ["-n", "--no-heading", "--color", "never", "-e", String(args.pattern), target], rt.cwd)
        : await run("grep", ["-rnI", "--exclude-dir=node_modules", "--exclude-dir=.git", "-e", String(args.pattern), target], rt.cwd);
      return out.split("\n").filter(Boolean).slice(0, MAX_LINES).join("\n") || "(no matches)";
    },
  },
];
