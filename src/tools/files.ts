import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { diffText } from "../diff";
import type { Runtime, ToolDef } from "../runtime";

export function resolvePath(p: string, cwd: string): string {
  const home = process.env.HOME ?? os.homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  return path.resolve(cwd, expanded);
}

function readOrNull(abs: string): string | null {
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
}

type Editor = (args: any, before: string | null, abs: string) => string;

function planWrite(args: any, rt: Runtime, editor: Editor) {
  const abs = resolvePath(String(args.path), rt.cwd);
  const before = readOrNull(abs);
  const after = editor(args, before, abs);
  return { abs, before, after, label: path.relative(rt.cwd, abs) || abs };
}

function applyWrite(rt: Runtime, plan: { abs: string; before: string | null; after: string; label: string }): string {
  rt.checkpoints.record(plan.abs, plan.before);
  fs.mkdirSync(path.dirname(plan.abs), { recursive: true });
  fs.writeFileSync(plan.abs, plan.after, "utf-8");
  rt.editedThisTurn = true;
  const d = diffText(plan.before ?? "", plan.after, plan.label);
  const kind = plan.before === null ? "Created" : "Wrote";
  return `${kind} ${plan.label} (+${d.added} -${d.removed})`;
}

function requireExisting(before: string | null, abs: string): string {
  if (before === null) throw new Error(`${abs} does not exist. Use write_file to create it.`);
  return before;
}

function lineRange(before: string, start: number, end: number): void {
  const count = before.split("\n").length;
  if (!(start >= 1 && end >= start && end <= count)) {
    throw new Error(`invalid range ${start}-${end}; the file has ${count} lines.`);
  }
}

const editors = {
  write_file: (args: any): string => String(args.content ?? ""),
  edit_file: (args: any, before: string | null, abs: string): string => {
    const src = requireExisting(before, abs);
    const oldString = String(args.old_string ?? "");
    if (!oldString) throw new Error("old_string is empty.");
    const count = src.split(oldString).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${abs}. read_file it again and copy the text exactly, or use replace_lines.`);
    }
    if (count > 1 && !args.replace_all) {
      throw new Error(`old_string matches ${count} places. Add more surrounding text, or set replace_all.`);
    }
    return src.split(oldString).join(String(args.new_string ?? ""));
  },
  replace_lines: (args: any, before: string | null, abs: string): string => {
    const src = requireExisting(before, abs);
    const start = Number(args.start_line);
    const end = Number(args.end_line);
    lineRange(src, start, end);
    const lines = src.split("\n");
    lines.splice(start - 1, end - start + 1, ...toLines(String(args.new_text ?? "")));
    return lines.join("\n");
  },
  insert_lines: (args: any, before: string | null, abs: string): string => {
    const src = requireExisting(before, abs);
    const after = Number(args.after_line);
    const count = src.split("\n").length;
    if (!(after >= 0 && after <= count)) throw new Error(`after_line ${after} is out of range; the file has ${count} lines.`);
    const lines = src.split("\n");
    lines.splice(after, 0, ...toLines(String(args.new_text ?? "")));
    return lines.join("\n");
  },
};

function toLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

function writeTool(
  name: string,
  description: string,
  parameters: any,
  editor: Editor,
): ToolDef {
  const compute = (args: any, rt: Runtime) => planWrite(args, rt, editor);
  return {
    name,
    description,
    kind: "write",
    parameters,
    subject: (args) => String(args.path ?? ""),
    preflight: async (args, rt) => {
      try {
        compute(args, rt);
        return null;
      } catch (e: any) {
        return { message: e.message, denied: false };
      }
    },
    preview: async (args, rt) => {
      const plan = compute(args, rt);
      return { title: plan.label, body: diffText(plan.before ?? "", plan.after, plan.label).text };
    },
    run: async (args, rt) => applyWrite(rt, compute(args, rt)),
  };
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

export const fileTools: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a file. Returns lines prefixed with line numbers. Use offset and limit for big files.",
    kind: "read",
    parameters: {
      type: "object",
      properties: { path: str("File path"), offset: num("First line, 1-based (default 1)"), limit: num("Max lines (default 300)") },
      required: ["path"],
    },
    subject: (args) => String(args.path ?? ""),
    run: async (args, rt) => {
      const abs = resolvePath(String(args.path), rt.cwd);
      const lines = fs.readFileSync(abs, "utf-8").split("\n");
      const start = Math.max(1, Number(args.offset ?? 1));
      const limit = Math.max(1, Number(args.limit ?? 300));
      const body = lines.slice(start - 1, start - 1 + limit).map((l, i) => `${start + i}\t${l}`).join("\n");
      const end = start - 1 + limit;
      const more = end < lines.length ? `\n[showing lines ${start}-${end} of ${lines.length}; use offset to read more]` : "";
      return body + more;
    },
  },
  writeTool(
    "write_file",
    "Create a file, or overwrite it completely. For small changes use edit_file, replace_lines or insert_lines.",
    {
      type: "object",
      properties: { path: str("File path"), content: str("Full file content") },
      required: ["path", "content"],
    },
    editors.write_file,
  ),
  writeTool(
    "edit_file",
    "Replace old_string with new_string. old_string must match exactly once unless replace_all is true.",
    {
      type: "object",
      properties: {
        path: str("File path"),
        old_string: str("Exact text to find"),
        new_string: str("Replacement text"),
        replace_all: { type: "boolean", description: "Replace every match" },
      },
      required: ["path", "old_string", "new_string"],
    },
    editors.edit_file,
  ),
  writeTool(
    "replace_lines",
    "Replace lines start_line..end_line (1-based, inclusive) with new_text.",
    {
      type: "object",
      properties: { path: str("File path"), start_line: num("First line"), end_line: num("Last line"), new_text: str("Replacement text") },
      required: ["path", "start_line", "end_line", "new_text"],
    },
    editors.replace_lines,
  ),
  writeTool(
    "insert_lines",
    "Insert new_text after line after_line (0 = top of file).",
    {
      type: "object",
      properties: { path: str("File path"), after_line: num("Insert after this line number"), new_text: str("Text to insert") },
      required: ["path", "after_line", "new_text"],
    },
    editors.insert_lines,
  ),
];
