// Eval task definitions for opencli. Each task seeds a temp dir, runs the agent,
// then judges the files on disk with check(dir). Checks never look at model text.
import fs from "node:fs";
import path from "node:path";

export interface EvalTask {
  id: string;
  category: "read" | "edit" | "multi-file" | "create" | "bugfix" | "search" | "shell" | "refactor";
  prompt: string;
  files: Record<string, string>;
  setup?: string;
  check: (dir: string) => boolean | Promise<boolean>;
}

// Helpers -------------------------------------------------------------------

const L = (...lines: string[]): string => lines.join("\n") + "\n";
const J = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";

function text(dir: string, rel: string): string {
  const p = path.join(dir, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function readJson(dir: string, rel: string): unknown {
  try {
    return JSON.parse(text(dir, rel));
  } catch {
    return undefined;
  }
}

// Runs `bun <args>` in dir and reports whether it exited 0.
function runBun(dir: string, args: string[]): boolean {
  const p = Bun.spawnSync([process.execPath, ...args], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  return p.exitCode === 0;
}

// Imports dir/mod with bun and evaluates `expr` with `m` bound to the module namespace.
function moduleCheck(dir: string, mod: string, expr: string): boolean {
  const code =
    `(async () => { const m = await import(${JSON.stringify(path.join(dir, mod))});` +
    ` process.exit((${expr}) ? 0 : 1); })().catch(() => process.exit(1));`;
  return runBun(dir, ["-e", code]);
}

export const tasks: EvalTask[] = [
  // read (3) ---------------------------------------------------------------
  {
    id: "read-config-port",
    category: "read",
    prompt: "Read config.json and write the value of server.port into answer.txt. Write only the number, nothing else.",
    files: {
      "config.json": J({ service: "billing", server: { host: "0.0.0.0", port: 8473 }, retries: 3 }),
    },
    check: (dir) => text(dir, "answer.txt").trim() === "8473",
  },
  {
    id: "read-retry-constant",
    category: "read",
    prompt: "Look at lib/retry.ts and write the value of MAX_RETRIES into answer.txt. Write only the number.",
    files: {
      "lib/retry.ts": L(
        "export const BASE_DELAY_MS = 250;",
        "export const MAX_RETRIES = 7;",
        "",
        "export function backoff(attempt: number): number {",
        "  return BASE_DELAY_MS * 2 ** attempt;",
        "}",
      ),
    },
    check: (dir) => text(dir, "answer.txt").trim() === "7",
  },
  {
    id: "read-error-count",
    category: "read",
    prompt: "Count the lines in app.log that start with ERROR and write the count into answer.txt. Write only the number.",
    files: {
      "app.log": L(
        "INFO start",
        "ERROR db timeout",
        "INFO retry",
        "ERROR db timeout",
        "WARN slow query",
        "ERROR disk full",
        "INFO done",
        "ERROR db timeout",
      ),
    },
    check: (dir) => text(dir, "answer.txt").trim() === "4",
  },

  // edit (5) ---------------------------------------------------------------
  {
    id: "edit-timeout-constant",
    category: "edit",
    prompt: "In src/client.ts, change TIMEOUT_MS from 3000 to 5000. Change nothing else.",
    files: {
      "src/client.ts": L(
        "export const TIMEOUT_MS = 3000;",
        "",
        "export async function ping(url: string): Promise<boolean> {",
        "  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });",
        "  return res.ok;",
        "}",
      ),
    },
    check: (dir) => {
      const s = text(dir, "src/client.ts");
      return (
        s.includes("export const TIMEOUT_MS = 5000;") &&
        !s.includes("3000") &&
        s.includes("AbortSignal.timeout(TIMEOUT_MS)")
      );
    },
  },
  {
    id: "edit-rename-local-variable",
    category: "edit",
    prompt: "In src/total.ts, rename the local variable acc to total everywhere in that file. Keep the function name and behavior.",
    files: {
      "src/total.ts": L(
        "export function sumPrices(items: number[]): number {",
        "  let acc = 0;",
        "  for (const x of items) {",
        "    acc += x;",
        "  }",
        "  return acc;",
        "}",
      ),
    },
    check: (dir) =>
      !/\bacc\b/.test(text(dir, "src/total.ts")) &&
      /\btotal\b/.test(text(dir, "src/total.ts")) &&
      moduleCheck(dir, "src/total.ts", "m.sumPrices([1, 2, 3]) === 6 && m.sumPrices([]) === 0"),
  },
  {
    id: "edit-insert-after-marker",
    category: "edit",
    prompt: 'In src/app.ts, add the line export const APP_VERSION = "1.0.0"; immediately after the line // END HEADER.',
    files: {
      "src/app.ts": L(
        "// BEGIN HEADER",
        'const APP_NAME = "demo";',
        "// END HEADER",
        "",
        "export function greet(): string {",
        '  return "hello from " + APP_NAME;',
        "}",
      ),
    },
    check: (dir) => {
      const lines = text(dir, "src/app.ts").split("\n");
      const idx = lines.indexOf("// END HEADER");
      return idx >= 0 && lines[idx + 1] === 'export const APP_VERSION = "1.0.0";';
    },
  },
  {
    id: "edit-fix-typo-string",
    category: "edit",
    prompt: "Fix the spelling mistake in the WELCOME string in src/messages.ts. Change nothing else.",
    files: {
      "src/messages.ts": L(
        'export const WELCOME = "Welcom to the service";',
        'export const GOODBYE = "Goodbye and thanks for visiting";',
      ),
    },
    check: (dir) => {
      const s = text(dir, "src/messages.ts");
      return (
        s.includes('export const WELCOME = "Welcome to the service";') &&
        s.includes('export const GOODBYE = "Goodbye and thanks for visiting";')
      );
    },
  },
  {
    id: "edit-flip-flag",
    category: "edit",
    prompt: "In src/config.ts, set DEBUG to false. Leave LEVEL unchanged.",
    files: {
      "src/config.ts": L("export const DEBUG = true;", 'export const LEVEL = "info";'),
    },
    check: (dir) => {
      const s = text(dir, "src/config.ts");
      return s.includes("export const DEBUG = false;") && s.includes('export const LEVEL = "info";');
    },
  },

  // multi-file (3) ---------------------------------------------------------
  {
    id: "multi-rename-export",
    category: "multi-file",
    prompt:
      "Rename the function formatPrice to formatCurrency everywhere it is defined or used in src/. Update the definition and both callers.",
    files: {
      "src/format.ts": L(
        "export function formatPrice(n: number): string {",
        '  return "$" + n.toFixed(2);',
        "}",
      ),
      "src/cart.ts": L(
        'import { formatPrice } from "./format.ts";',
        "",
        "export function cartLine(n: number): string {",
        '  return "Total: " + formatPrice(n);',
        "}",
      ),
      "src/invoice.ts": L(
        'import { formatPrice } from "./format.ts";',
        "",
        "export function invoiceLine(n: number): string {",
        '  return "Due: " + formatPrice(n);',
        "}",
      ),
    },
    check: (dir) => {
      const files = ["src/format.ts", "src/cart.ts", "src/invoice.ts"];
      if (files.some((f) => text(dir, f).includes("formatPrice"))) return false;
      return (
        text(dir, "src/format.ts").includes("export function formatCurrency(") &&
        moduleCheck(dir, "src/format.ts", 'm.formatCurrency(3) === "$3.00"') &&
        moduleCheck(dir, "src/cart.ts", 'm.cartLine(1.5) === "Total: $1.50"') &&
        moduleCheck(dir, "src/invoice.ts", 'm.invoiceLine(2) === "Due: $2.00"')
      );
    },
  },
  {
    id: "multi-add-field-type",
    category: "multi-file",
    prompt:
      "Add a required field email: string to the User interface in src/types.ts. Update makeUser in src/db.ts to take an email as a third argument and store it on the user. Keep label in src/render.ts working.",
    files: {
      "src/types.ts": L("export interface User {", "  id: number;", "  name: string;", "}"),
      "src/db.ts": L(
        'import type { User } from "./types.ts";',
        "",
        "export function makeUser(id: number, name: string): User {",
        "  return { id, name };",
        "}",
      ),
      "src/render.ts": L(
        'import type { User } from "./types.ts";',
        "",
        "export function label(u: User): string {",
        "  return `${u.id}:${u.name}`;",
        "}",
      ),
    },
    check: (dir) =>
      /^\s*email:\s*string;/m.test(text(dir, "src/types.ts")) &&
      moduleCheck(dir, "src/db.ts", 'm.makeUser(1, "ann", "ann@x.io").email === "ann@x.io" && m.makeUser(1, "ann", "a@b.c").name === "ann"') &&
      moduleCheck(dir, "src/render.ts", 'm.label({ id: 1, name: "ann", email: "a" }) === "1:ann"'),
  },
  {
    id: "multi-version-strings",
    category: "multi-file",
    prompt: "Bump the version from 0.4.0 to 0.5.0 in package.json and src/version.ts. Do not change anything else.",
    files: {
      "package.json": J({ name: "demo-app", version: "0.4.0" }),
      "src/version.ts": L('export const VERSION = "0.4.0";'),
    },
    check: (dir) => {
      const pkg = readJson(dir, "package.json") as { name?: unknown; version?: unknown } | undefined;
      return (
        pkg?.name === "demo-app" &&
        pkg?.version === "0.5.0" &&
        text(dir, "src/version.ts").includes('export const VERSION = "0.5.0";')
      );
    },
  },

  // create (3) -------------------------------------------------------------
  {
    id: "create-hello-txt",
    category: "create",
    prompt: "Create a file named hello.txt in the current directory whose entire content is the single line: Hello, opencli!",
    files: {},
    check: (dir) => text(dir, "hello.txt").trim() === "Hello, opencli!",
  },
  {
    id: "create-slugify-module",
    category: "create",
    prompt:
      "Create slug.ts exporting slugify(s: string): string. It lowercases the input, trims it, replaces each run of characters that are not a-z or 0-9 with a single hyphen, and strips leading and trailing hyphens. Example: slugify('  Hello, World! ') returns 'hello-world'.",
    files: {},
    check: (dir) =>
      moduleCheck(
        dir,
        "slug.ts",
        'm.slugify("  Hello, World! ") === "hello-world" && m.slugify("a__b  c") === "a-b-c" && m.slugify("--x--") === "x"',
      ),
  },
  {
    id: "create-settings-json",
    category: "create",
    prompt:
      'Create settings.json in the current directory containing a JSON object with these keys: "name" set to "demo-app", "version" set to the number 2, "features" set to the array ["search", "export"], and "debug" set to false.',
    files: {},
    check: (dir) => {
      const o = readJson(dir, "settings.json") as Record<string, unknown> | undefined;
      return (
        !!o &&
        o.name === "demo-app" &&
        o.version === 2 &&
        JSON.stringify(o.features) === JSON.stringify(["search", "export"]) &&
        o.debug === false
      );
    },
  },

  // bugfix (4) -------------------------------------------------------------
  bugfix(
    "bugfix-slice-off-by-one",
    "The tests in test.ts fail. Fix the bug in src/first.ts so that bun test test.ts passes.",
    "src/first.ts",
    L("export function firstN(xs: number[], n: number): number[] {", "  return xs.slice(0, n - 1);", "}"),
    L(
      'import { test, expect } from "bun:test";',
      'import { firstN } from "./src/first.ts";',
      "",
      'test("returns the first n items", () => {',
      "  expect(firstN([1, 2, 3, 4], 2)).toEqual([1, 2]);",
      "});",
      "",
      'test("n of zero gives an empty array", () => {',
      "  expect(firstN([1, 2], 0)).toEqual([]);",
      "});",
      "",
      'test("n larger than the array returns all items", () => {',
      "  expect(firstN([1, 2], 5)).toEqual([1, 2]);",
      "});",
    ),
  ),
  bugfix(
    "bugfix-inverted-condition",
    "The tests in test.ts fail. Fix the bug in src/access.ts so that bun test test.ts passes.",
    "src/access.ts",
    L("export function isValidPort(p: number): boolean {", "  return p < 1 || p > 65535;", "}"),
    L(
      'import { test, expect } from "bun:test";',
      'import { isValidPort } from "./src/access.ts";',
      "",
      'test("in-range ports are valid", () => {',
      "  expect(isValidPort(80)).toBe(true);",
      "  expect(isValidPort(65535)).toBe(true);",
      "});",
      "",
      'test("out-of-range ports are invalid", () => {',
      "  expect(isValidPort(0)).toBe(false);",
      "  expect(isValidPort(70000)).toBe(false);",
      "});",
    ),
  ),
  bugfix(
    "bugfix-missing-return",
    "The tests in test.ts fail. Fix the bug in src/stats.ts so that bun test test.ts passes.",
    "src/stats.ts",
    L(
      "export function average(xs: number[]): number {",
      "  if (xs.length === 0) return 0;",
      "  let sum = 0;",
      "  for (const x of xs) sum += x;",
      "  sum / xs.length;",
      "}",
    ),
    L(
      'import { test, expect } from "bun:test";',
      'import { average } from "./src/stats.ts";',
      "",
      'test("average of several numbers", () => {',
      "  expect(average([1, 2, 3])).toBe(2);",
      "  expect(average([5])).toBe(5);",
      "});",
      "",
      'test("average of an empty list is 0", () => {',
      "  expect(average([])).toBe(0);",
      "});",
    ),
  ),
  bugfix(
    "bugfix-string-comparison",
    "The tests in test.ts fail. isNewer compares versions as plain strings, so 1.10.0 is not treated as newer than 1.9.0. Fix src/versions.ts so it compares the dotted numeric parts, and bun test test.ts passes.",
    "src/versions.ts",
    L("export function isNewer(a: string, b: string): boolean {", "  return a > b;", "}"),
    L(
      'import { test, expect } from "bun:test";',
      'import { isNewer } from "./src/versions.ts";',
      "",
      'test("compares numeric parts", () => {',
      '  expect(isNewer("1.10.0", "1.9.0")).toBe(true);',
      '  expect(isNewer("2.0.0", "1.9.9")).toBe(true);',
      '  expect(isNewer("1.2.0", "1.10.0")).toBe(false);',
      "});",
      "",
      'test("equal versions are not newer", () => {',
      '  expect(isNewer("1.0.0", "1.0.0")).toBe(false);',
      "});",
    ),
  ),

  // search (4) -------------------------------------------------------------
  {
    id: "search-find-marker-file",
    category: "search",
    prompt:
      "Find the one file under this directory that contains the text ZETA_MARKER_7731. Write its path, relative to the current directory, into answer.txt. Write only the path.",
    files: {
      "src/api/routes.ts": L('export const routes = ["/users", "/orders"];'),
      "src/billing/invoice.ts": L('export const INVOICE_TAG = "ZETA_MARKER_7731";'),
      "src/billing/tax.ts": L("export const TAX_RATE = 0.2;"),
      "lib/util/strings.ts": L('export const EMPTY = "";'),
      "docs/notes.md": L("# Notes", "Nothing to see here."),
    },
    check: (dir) => text(dir, "answer.txt").trim().replace(/^\.\//, "") === "src/billing/invoice.ts",
  },
  {
    id: "search-count-token",
    category: "search",
    prompt:
      "Count how many times the token TODO appears in total across all files under notes/ (including subdirectories). Write only the total number into count.txt.",
    files: {
      "notes/a.md": L("TODO: write intro", "Some text.", "TODO: add example"),
      "notes/b.txt": L("nothing here", "TODO: fix link"),
      "notes/sub/c.md": L("TODO first", "TODO second", "done"),
      "notes/d.txt": L("all done", "TODO and TODO again"),
    },
    check: (dir) => text(dir, "count.txt").trim() === "7",
  },
  {
    id: "search-list-extension",
    category: "search",
    prompt:
      "List every .md file in this directory tree (including subdirectories) into list.txt, one relative path per line, sorted by plain character order. Write nothing else into the file.",
    files: {
      "README.md": L("# Project"),
      "docs/api.md": L("# API"),
      "docs/guide/setup.md": L("# Setup"),
      "src/index.ts": L("export {};"),
      "src/notes.txt": L("x"),
      "data.json": L("{}"),
    },
    check: (dir) => {
      const lines = text(dir, "list.txt")
        .split("\n")
        .map((l) => l.trim().replace(/^\.\//, ""))
        .filter((l) => l.length > 0);
      return JSON.stringify(lines) === JSON.stringify(["README.md", "docs/api.md", "docs/guide/setup.md"]);
    },
  },
  {
    id: "search-find-definition-file",
    category: "search",
    prompt:
      "Find the file that defines the function computeChecksum (not the files that only use it). Write its path, relative to the current directory, into answer.txt. Write only the path.",
    files: {
      "src/a.ts": L("export function add(a: number, b: number) { return a + b; }"),
      "src/crypto/hash.ts": L(
        "export function computeChecksum(data: string): number {",
        "  let h = 0;",
        "  for (const ch of data) h = (h * 31 + ch.charCodeAt(0)) % 65521;",
        "  return h;",
        "}",
      ),
      "src/util.ts": L("export function noop() {}"),
      "tests/hash.test.ts": L('import { computeChecksum } from "../src/crypto/hash.ts";'),
    },
    check: (dir) => text(dir, "answer.txt").trim().replace(/^\.\//, "") === "src/crypto/hash.ts",
  },

  // shell (4) --------------------------------------------------------------
  {
    id: "shell-line-count",
    category: "shell",
    prompt: "Count the lines in data.txt and write only that number into count.txt.",
    files: {
      "data.txt": Array.from({ length: 37 }, (_, i) => `row ${i + 1}`).join("\n") + "\n",
    },
    check: (dir) => text(dir, "count.txt").trim() === "37",
  },
  {
    id: "shell-csv-sum",
    category: "shell",
    prompt: "Sum the amount column of sales.csv (ignore the header row) and write the total into total.txt. Write only the number.",
    files: {
      "sales.csv": L("item,amount", "apple,12.50", "pear,3.25", "fig,7", "plum,0.75", "kiwi,4.10", "lime,10.40"),
    },
    check: (dir) => Math.abs(Number(text(dir, "total.txt").trim()) - 38) < 1e-6,
  },
  {
    id: "shell-mkdir-touch",
    category: "shell",
    prompt:
      "Create this structure under the current directory using shell commands: directories build/logs and build/out, an empty file build/logs/app.log, and an empty file build/out/index.html.",
    files: {},
    check: (dir) => {
      const isDir = (rel: string) => fs.existsSync(path.join(dir, rel)) && fs.statSync(path.join(dir, rel)).isDirectory();
      const isEmpty = (rel: string) => fs.existsSync(path.join(dir, rel)) && fs.statSync(path.join(dir, rel)).isFile() && fs.statSync(path.join(dir, rel)).size === 0;
      return isDir("build/logs") && isDir("build/out") && isEmpty("build/logs/app.log") && isEmpty("build/out/index.html");
    },
  },
  {
    id: "shell-count-inbox-files",
    category: "shell",
    prompt:
      "Count the regular files directly inside inbox/ (not counting subdirectories or anything inside them) and write the number into inbox_count.txt. Write only the number.",
    setup: "mkdir -p inbox/archive && echo old > inbox/archive/old.txt",
    files: {
      "inbox/a.txt": "1\n",
      "inbox/b.txt": "2\n",
      "inbox/c.log": "3\n",
      "inbox/d.md": "4\n",
    },
    check: (dir) => text(dir, "inbox_count.txt").trim() === "4",
  },

  // refactor (4) -----------------------------------------------------------
  {
    id: "refactor-arrow-function",
    category: "refactor",
    prompt:
      'Convert the greet function in src/greet.ts to an arrow function assigned to a const named greet, keeping the export, the parameters, the default value, and the behavior.',
    files: {
      "src/greet.ts": L('export function greet(name: string, punct = "!"): string {', '  return "Hello, " + name + punct;', "}"),
    },
    check: (dir) => {
      const s = text(dir, "src/greet.ts");
      return (
        s.includes("export const greet") &&
        !s.includes("export function greet") &&
        moduleCheck(dir, "src/greet.ts", 'm.greet("Ann") === "Hello, Ann!" && m.greet("Bo", "?") === "Hello, Bo?"')
      );
    },
  },
  {
    id: "refactor-extract-helper",
    category: "refactor",
    prompt:
      "The expression title.trim().toUpperCase() is duplicated in src/report.ts. Extract it into a helper function named normalizeTitle in the same file and use it in both functions. Do not edit test.ts. Then make sure bun test test.ts passes.",
    files: {
      "src/report.ts": L(
        "export function headline(title: string, n: number): string {",
        "  return `${title.trim().toUpperCase()} (${n})`;",
        "}",
        "",
        "export function footer(title: string, n: number): string {",
        "  return `${title.trim().toUpperCase()} - ${n} items`;",
        "}",
      ),
      "test.ts": L(
        'import { test, expect } from "bun:test";',
        'import { headline, footer } from "./src/report.ts";',
        "",
        'test("headline", () => {',
        '  expect(headline("  sales ", 3)).toBe("SALES (3)");',
        "});",
        "",
        'test("footer", () => {',
        '  expect(footer(" ops", 2)).toBe("OPS - 2 items");',
        "});",
      ),
    },
    check: (dir) => {
      const s = text(dir, "src/report.ts");
      const occurrences = s.split("title.trim().toUpperCase()").length - 1;
      return (
        text(dir, "test.ts").includes('expect(headline("  sales ", 3)).toBe("SALES (3)");') &&
        s.includes("normalizeTitle") &&
        occurrences <= 1 &&
        runBun(dir, ["test", "./test.ts"])
      );
    },
  },
  {
    id: "refactor-loop-to-map",
    category: "refactor",
    prompt: "Replace the for loop in doubleAll in src/doubles.ts with Array.prototype.map. Keep the same behavior and signature.",
    files: {
      "src/doubles.ts": L(
        "export function doubleAll(xs: number[]): number[] {",
        "  const out: number[] = [];",
        "  for (let i = 0; i < xs.length; i++) {",
        "    out.push(xs[i] * 2);",
        "  }",
        "  return out;",
        "}",
      ),
    },
    check: (dir) => {
      const s = text(dir, "src/doubles.ts");
      return (
        s.includes(".map(") &&
        !/\bfor\s*\(/.test(s) &&
        moduleCheck(dir, "src/doubles.ts", "JSON.stringify(m.doubleAll([1, 2, 3])) === '[2,4,6]' && JSON.stringify(m.doubleAll([])) === '[]'")
      );
    },
  },
  {
    id: "refactor-move-constant",
    category: "refactor",
    prompt:
      "Move the constant MAX_UPLOAD_BYTES out of src/upload.ts into a new file src/constants.ts as an exported constant, and import it back into src/upload.ts. Behavior must not change.",
    files: {
      "src/upload.ts": L(
        "const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;",
        "",
        "export function isTooLarge(size: number): boolean {",
        "  return size > MAX_UPLOAD_BYTES;",
        "}",
      ),
    },
    check: (dir) => {
      const upload = text(dir, "src/upload.ts");
      const constants = text(dir, "src/constants.ts");
      return (
        constants.includes("export const MAX_UPLOAD_BYTES") &&
        /import\s*\{[^}]*\bMAX_UPLOAD_BYTES\b[^}]*\}\s*from\s*["']\.\/constants(\.ts)?["']/.test(upload) &&
        !/const MAX_UPLOAD_BYTES\s*=/.test(upload) &&
        moduleCheck(dir, "src/upload.ts", "m.isTooLarge(5 * 1024 * 1024 + 1) === true && m.isTooLarge(5 * 1024 * 1024) === false")
      );
    },
  },
];

// Builds a bugfix task: a module with a bug plus a bun:test file that must pass
// unchanged. The check also rejects edits to test.ts so the agent cannot pass by
// rewriting the tests.
function bugfix(id: string, prompt: string, mod: string, modSrc: string, testSrc: string): EvalTask {
  return {
    id,
    category: "bugfix",
    prompt: `${prompt} Do not edit test.ts.`,
    files: { [mod]: modSrc, "test.ts": testSrc },
    check: (dir) => text(dir, "test.ts") === testSrc && runBun(dir, ["test", "./test.ts"]),
  };
}
