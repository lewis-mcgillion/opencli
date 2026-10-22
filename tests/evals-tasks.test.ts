// Verifies the eval task checks in evals/tasks.ts without calling any model.
// For every task: a hand-written solution must pass check(), and the untouched
// starting state must fail it. A few extra cases confirm bugfix tests cannot be
// gamed by editing test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tasks, type EvalTask } from "../evals/tasks.ts";

type Files = Record<string, string>;
type Solution = (original: Files) => Files;

const L = (...lines: string[]): string => lines.join("\n") + "\n";
const J = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

// Replace text in one original file.
const rep =
  (rel: string, from: string | RegExp, to: string): Solution =>
  (f) => ({ [rel]: f[rel]!.replace(from, to) });

const solutions: Record<string, Solution> = {
  // read
  "read-config-port": () => ({ "answer.txt": "8473\n" }),
  "read-retry-constant": () => ({ "answer.txt": "7\n" }),
  "read-error-count": () => ({ "answer.txt": "4\n" }),

  // edit
  "edit-timeout-constant": rep("src/client.ts", "3000", "5000"),
  "edit-rename-local-variable": rep("src/total.ts", /\bacc\b/g, "total"),
  "edit-insert-after-marker": rep("src/app.ts", "// END HEADER\n", '// END HEADER\nexport const APP_VERSION = "1.0.0";\n'),
  "edit-fix-typo-string": rep("src/messages.ts", "Welcom to", "Welcome to"),
  "edit-flip-flag": rep("src/config.ts", "DEBUG = true", "DEBUG = false"),

  // multi-file
  "multi-rename-export": (f) =>
    Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.replaceAll("formatPrice", "formatCurrency")])),
  "multi-add-field-type": () => ({
    "src/types.ts": L("export interface User {", "  id: number;", "  name: string;", "  email: string;", "}"),
    "src/db.ts": L(
      'import type { User } from "./types.ts";',
      "",
      "export function makeUser(id: number, name: string, email: string): User {",
      "  return { id, name, email };",
      "}",
    ),
  }),
  "multi-version-strings": () => ({
    "package.json": J({ name: "demo-app", version: "0.5.0" }),
    "src/version.ts": L('export const VERSION = "0.5.0";'),
  }),

  // create
  "create-hello-txt": () => ({ "hello.txt": "Hello, llmcli!\n" }),
  "create-slugify-module": () => ({
    "slug.ts": L(
      "export function slugify(s: string): string {",
      '  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");',
      "}",
    ),
  }),
  "create-settings-json": () => ({
    "settings.json": J({ name: "demo-app", version: 2, features: ["search", "export"], debug: false }),
  }),

  // bugfix
  "bugfix-slice-off-by-one": rep("src/first.ts", "n - 1", "n"),
  "bugfix-inverted-condition": rep("src/access.ts", "return p < 1 || p > 65535;", "return p >= 1 && p <= 65535;"),
  "bugfix-missing-return": rep("src/stats.ts", "  sum / xs.length;", "  return sum / xs.length;"),
  "bugfix-string-comparison": () => ({
    "src/versions.ts": L(
      "export function isNewer(a: string, b: string): boolean {",
      "  const pa = a.split(\".\").map(Number);",
      "  const pb = b.split(\".\").map(Number);",
      "  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {",
      "    const x = pa[i] ?? 0;",
      "    const y = pb[i] ?? 0;",
      "    if (x !== y) return x > y;",
      "  }",
      "  return false;",
      "}",
    ),
  }),

  // search
  "search-find-marker-file": () => ({ "answer.txt": "src/billing/invoice.ts\n" }),
  "search-count-token": () => ({ "count.txt": "7\n" }),
  "search-list-extension": () => ({ "list.txt": L("README.md", "docs/api.md", "docs/guide/setup.md") }),
  "search-find-definition-file": () => ({ "answer.txt": "src/crypto/hash.ts\n" }),

  // shell
  "shell-line-count": () => ({ "count.txt": "37\n" }),
  "shell-csv-sum": () => ({ "total.txt": "38\n" }),
  "shell-mkdir-touch": () => ({ "build/logs/app.log": "", "build/out/index.html": "" }),
  "shell-count-inbox-files": () => ({ "inbox_count.txt": "4\n" }),

  // refactor
  "refactor-arrow-function": () => ({
    "src/greet.ts": L('export const greet = (name: string, punct = "!"): string => {', '  return "Hello, " + name + punct;', "};"),
  }),
  "refactor-extract-helper": () => ({
    "src/report.ts": L(
      "function normalizeTitle(title: string): string {",
      "  return title.trim().toUpperCase();",
      "}",
      "",
      "export function headline(title: string, n: number): string {",
      "  return `${normalizeTitle(title)} (${n})`;",
      "}",
      "",
      "export function footer(title: string, n: number): string {",
      "  return `${normalizeTitle(title)} - ${n} items`;",
      "}",
    ),
  }),
  "refactor-loop-to-map": () => ({
    "src/doubles.ts": L("export function doubleAll(xs: number[]): number[] {", "  return xs.map((x) => x * 2);", "}"),
  }),
  "refactor-move-constant": () => ({
    "src/constants.ts": L("export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;"),
    "src/upload.ts": L(
      'import { MAX_UPLOAD_BYTES } from "./constants.ts";',
      "",
      "export function isTooLarge(size: number): boolean {",
      "  return size > MAX_UPLOAD_BYTES;",
      "}",
    ),
  }),
};

const made: string[] = [];

function write(dir: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

// Builds the starting state for a task, optionally applying a solution on top.
function materialize(task: EvalTask, solution?: Solution): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llmcli-task-test-"));
  made.push(dir);
  write(dir, task.files);
  if (task.setup) {
    const p = Bun.spawnSync(["/bin/zsh", "-c", task.setup], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    expect(p.exitCode).toBe(0);
  }
  if (solution) write(dir, solution(task.files));
  return dir;
}

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

describe("eval task suite shape", () => {
  test("has 30 tasks with unique ids", () => {
    expect(tasks.length).toBe(30);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(30);
  });

  test("covers all 8 categories with at least 3 tasks each", () => {
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    const categories = ["read", "edit", "multi-file", "create", "bugfix", "search", "shell", "refactor"];
    for (const c of categories) expect(counts.get(c) ?? 0).toBeGreaterThanOrEqual(3);
    expect(counts.size).toBe(8);
  });

  test("every task has a hand-written solution", () => {
    for (const t of tasks) expect(solutions[t.id]).toBeDefined();
  });
});

describe("solved state passes check", () => {
  for (const task of tasks) {
    test(task.id, async () => {
      const dir = materialize(task, solutions[task.id]);
      expect(await task.check(dir)).toBe(true);
    }, 30_000);
  }
});

describe("starting state fails check", () => {
  for (const task of tasks) {
    test(task.id, async () => {
      const dir = materialize(task);
      expect(await task.check(dir)).toBe(false);
    }, 30_000);
  }
});

describe("bugfix tasks cannot be gamed", () => {
  test("editing test.ts makes the check fail even if the code is fixed", async () => {
    const task = tasks.find((t) => t.id === "bugfix-slice-off-by-one")!;
    const dir = materialize(task, (f) => ({
      "src/first.ts": f["src/first.ts"]!.replace("n - 1", "n"),
      "test.ts": "import { test } from \"bun:test\";\ntest(\"noop\", () => {});\n",
    }));
    expect(await task.check(dir)).toBe(false);
  }, 30_000);
});
