import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_FILES = 400;
const MAX_SYMBOLS_PER_FILE = 25;

const PATTERNS: Record<string, RegExp[]> = {
  ".ts": [/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)/gm],
  ".py": [/^(?:class|def|async\s+def)\s+([A-Za-z_]\w*)/gm],
  ".go": [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^type\s+([A-Za-z_]\w*)/gm],
  ".rs": [/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/gm],
};
PATTERNS[".tsx"] = PATTERNS[".ts"];
PATTERNS[".js"] = PATTERNS[".ts"];
PATTERNS[".jsx"] = PATTERNS[".ts"];
PATTERNS[".mjs"] = PATTERNS[".ts"];
PATTERNS[".cjs"] = PATTERNS[".ts"];

function listFiles(cwd: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd, encoding: "utf-8", maxBuffer: 10_000_000 })
      .split("\n")
      .filter(Boolean);
  } catch {
    return walk(cwd, cwd, 0);
  }
}

function walk(root: string, dir: string, depth: number): string[] {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(root, full, depth + 1));
    else out.push(path.relative(root, full));
  }
  return out;
}

function symbolsIn(file: string, text: string): string[] {
  const patterns = PATTERNS[path.extname(file)];
  if (!patterns) return [];
  const names: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      if (!names.includes(m[1])) names.push(m[1]);
      if (names.length >= MAX_SYMBOLS_PER_FILE) return names;
    }
  }
  return names;
}

export function buildRepoMap(cwd: string, budgetChars = 6000): string {
  const files = listFiles(cwd).sort().slice(0, MAX_FILES);
  const lines: string[] = [];
  let used = 0;
  for (const file of files) {
    let text = "";
    try {
      const stat = fs.statSync(path.join(cwd, file));
      if (!stat.isFile() || stat.size > 300_000) continue;
      text = fs.readFileSync(path.join(cwd, file), "utf-8");
    } catch {
      continue;
    }
    const symbols = symbolsIn(file, text);
    const line = symbols.length ? `${file}: ${symbols.join(", ")}` : file;
    if (used + line.length > budgetChars) {
      lines.push(`[${files.length - lines.length} more files not listed]`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
