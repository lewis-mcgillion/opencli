import * as fs from "node:fs";
import * as path from "node:path";
import { projectSettingsDir, userConfigDir } from "../config";
import type { Command, CommandResult } from "./index";

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function commandFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(dir, f));
}

export function loadCustomCommands(cwd: string, builtinNames: Set<string>): Command[] {
  const seen = new Set<string>(builtinNames);
  const commands: Command[] = [];
  const dirs = [path.join(projectSettingsDir(cwd), "commands"), path.join(userConfigDir(), "commands")];
  for (const dir of dirs) {
    for (const file of commandFiles(dir)) {
      const name = path.basename(file, ".md");
      if (seen.has(name)) continue;
      seen.add(name);
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf-8"));
      const allowedTools = meta["allowed-tools"]
        ? meta["allowed-tools"].split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      commands.push({
        name,
        help: meta.description ?? `custom command from ${file}`,
        run: (arg): CommandResult => ({ send: body.replace(/\$ARGUMENTS/g, arg.trim()).trim(), allowedTools }),
      });
    }
  }
  return commands;
}
