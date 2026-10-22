import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeTool } from "../src/execute";
import { recordingUi, makeRuntime, tempDir } from "./helpers/runtime";
import type { Runtime } from "../src/runtime";

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (rt: Runtime, name: string, args: object) => executeTool(rt, name, JSON.stringify(args));

describe("edit tools", () => {
  test("edit_file asks with a diff preview and writes only after approval", async () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "one\ntwo\nthree\n");
    const ui = recordingUi(true);
    const rt = makeRuntime(dir, ui);
    const result = await call(rt, "edit_file", { path: "a.txt", old_string: "two", new_string: "2" });
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(file, "utf-8")).toBe("one\n2\nthree\n");
    expect(ui.previews[0].body).toContain("-two");
    expect(ui.previews[0].body).toContain("+2");
    expect(ui.questions.length).toBe(1);
  });

  test("rejected edit leaves the file untouched and counts as a denial", async () => {
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "keep\n");
    const rt = makeRuntime(dir, recordingUi(false));
    const result = await call(rt, "write_file", { path: "a.txt", content: "changed\n" });
    expect(result.denied).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("keep\n");
    expect(rt.session.denials).toBe(1);
  });

  test("auto mode writes without asking", async () => {
    const ui = recordingUi(null);
    const rt = makeRuntime(dir, ui, { mode: "auto" });
    const result = await call(rt, "write_file", { path: "new/deep/file.txt", content: "hi\n" });
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, "new/deep/file.txt"), "utf-8")).toBe("hi\n");
    expect(ui.questions.length).toBe(0);
  });

  test("invalid edits fail before any approval is requested", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "x x\n");
    const ui = recordingUi(true);
    const rt = makeRuntime(dir, ui);
    const ambiguous = await call(rt, "edit_file", { path: "a.txt", old_string: "x", new_string: "y" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.output).toContain("matches 2 places");
    const missing = await call(rt, "edit_file", { path: "nope.txt", old_string: "x", new_string: "y" });
    expect(missing.output).toContain("does not exist");
    expect(ui.questions.length).toBe(0);
    expect(rt.session.denials).toBe(0);
  });

  test("replace_lines and insert_lines validate ranges", async () => {
    fs.writeFileSync(path.join(dir, "f.txt"), "a\nb\nc\n");
    const rt = makeRuntime(dir, recordingUi(true), { mode: "auto" });
    expect((await call(rt, "replace_lines", { path: "f.txt", start_line: 2, end_line: 2, new_text: "B" })).isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf-8")).toBe("a\nB\nc\n");
    const bad = await call(rt, "replace_lines", { path: "f.txt", start_line: 9, end_line: 9, new_text: "x" });
    expect(bad.output).toContain("invalid range");
    expect((await call(rt, "insert_lines", { path: "f.txt", after_line: 0, new_text: "top" })).isError).toBe(false);
    expect(fs.readFileSync(path.join(dir, "f.txt"), "utf-8").startsWith("top\na\n")).toBe(true);
  });

  test("checkpoints undo the last turn, including file creation", async () => {
    fs.writeFileSync(path.join(dir, "keep.txt"), "original\n");
    const rt = makeRuntime(dir, recordingUi(null), { mode: "auto" });
    await call(rt, "write_file", { path: "keep.txt", content: "changed\n" });
    await call(rt, "write_file", { path: "created.txt", content: "new\n" });
    rt.checkpoints.commit();
    const restored = rt.checkpoints.undo();
    expect(restored?.length).toBe(2);
    expect(fs.readFileSync(path.join(dir, "keep.txt"), "utf-8")).toBe("original\n");
    expect(fs.existsSync(path.join(dir, "created.txt"))).toBe(false);
    expect(rt.checkpoints.undo()).toBeNull();
  });
});

describe("read and search tools", () => {
  test("read_file numbers lines and reports the remainder", async () => {
    fs.writeFileSync(path.join(dir, "n.txt"), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n"));
    const rt = makeRuntime(dir, recordingUi(null));
    const result = await call(rt, "read_file", { path: "n.txt", offset: 2, limit: 2 });
    expect(result.output).toContain("2\tline2");
    expect(result.output).toContain("showing lines 2-3 of 10");
  });

  test("grep_files and glob_files find matches inside the project", async () => {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const needle = 1;\n");
    fs.writeFileSync(path.join(dir, "src", "b.txt"), "needle\n");
    const rt = makeRuntime(dir, recordingUi(null));
    const grep = await call(rt, "grep_files", { pattern: "needle", path: "src" });
    expect(grep.output).toContain("a.ts");
    const glob = await call(rt, "glob_files", { pattern: "*.ts", path: "src" });
    expect(glob.output).toContain("a.ts");
    expect(glob.output).not.toContain("b.txt");
  });

  test("missing required parameters are reported by name", async () => {
    const rt = makeRuntime(dir, recordingUi(null));
    const result = await call(rt, "read_file", {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("path");
  });

  test("unknown tools and bad JSON are errors, not crashes", async () => {
    const rt = makeRuntime(dir, recordingUi(null));
    expect((await call(rt, "does_not_exist", {})).output).toContain("unknown tool");
    const badJson = await executeTool(rt, "read_file", "{nope");
    expect(badJson.output).toContain("not valid JSON");
  });

  test("subagent allowlist blocks tools outside it", async () => {
    const rt = makeRuntime(dir, recordingUi(null));
    rt.allowedTools = new Set(["read_file"]);
    const result = await call(rt, "write_file", { path: "x.txt", content: "y" });
    expect(result.output).toContain("not available in this context");
    expect(fs.existsSync(path.join(dir, "x.txt"))).toBe(false);
  });
});

describe("shell tools", () => {
  test("run_bash runs safe commands without approval", async () => {
    const ui = recordingUi(null);
    const rt = makeRuntime(dir, ui);
    const result = await call(rt, "run_bash", { command: "echo hi && pwd" });
    expect(result.output).toContain("hi");
    expect(ui.questions.length).toBe(0);
  });

  test("run_bash without a user refuses commands that need approval", async () => {
    fs.writeFileSync(path.join(dir, "keep.txt"), "x");
    const rt = makeRuntime(dir, recordingUi(null));
    const result = await call(rt, "run_bash", { command: "rm -rf keep.txt" });
    expect(result.denied).toBe(true);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
  });

  test("git tool blocks push without a user", async () => {
    const rt = makeRuntime(dir, recordingUi(null));
    const result = await call(rt, "git", { args: "-C . push origin main" });
    expect(result.denied).toBe(true);
  });

  test("background jobs can be read and stopped", async () => {
    const rt = makeRuntime(dir, recordingUi(true));
    const started = await call(rt, "run_bash", { command: "echo started-job; sleep 5", background: true });
    const id = /job-\d+/.exec(started.output)?.[0];
    expect(id).toBeDefined();
    await new Promise((r) => setTimeout(r, 300));
    const out = await call(rt, "bash_output", { job: id });
    expect(out.output).toContain("started-job");
    const killed = await call(rt, "bash_kill", { job: id });
    expect(killed.output).toContain("Stopped");
  });
});

describe("web tool", () => {
  test("refuses loopback without an allow rule", async () => {
    const rt = makeRuntime(dir, recordingUi(null));
    const result = await call(rt, "web_fetch", { url: "http://127.0.0.1:9/" });
    expect(result.denied).toBe(true);
    expect(result.output).toContain("private");
  });

  test("an explicit allow rule lets the request through the private check", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<html><body><p>hello   there</p></body></html>", { headers: { "content-type": "text/html" } }) });
    try {
      const rt = makeRuntime(dir, recordingUi(null), { config: { permissions: { allow: [`web_fetch(http://127.0.0.1:${server.port}/*)`], ask: [], deny: [] } } });
      const result = await call(rt, "web_fetch", { url: `http://127.0.0.1:${server.port}/page` });
      expect(result.isError).toBe(false);
      expect(result.output).toBe("hello there");
    } finally {
      server.stop(true);
    }
  });
});
