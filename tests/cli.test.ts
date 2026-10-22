import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startFakeModel, type FakeModel, type ScriptStep } from "./helpers/fake-model";
import { tempDir } from "./helpers/runtime";

const MAIN = path.resolve(import.meta.dir, "../src/main.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts: { cwd: string; home: string; stdin?: string }): Promise<Run> {
  const proc = Bun.spawn([process.execPath, "run", MAIN, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: opts.home, LLMCLI_MODEL: "test-model", LLMCLI_URL: "" },
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

let home: string;
let project: string;

beforeAll(() => {
  home = tempDir("llmcli-home-");
  project = tempDir("llmcli-project-");
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function withModel(script: ScriptStep[], body: (fake: FakeModel) => Promise<void>) {
  return async () => {
    const fake = startFakeModel(script);
    try {
      await body(fake);
    } finally {
      fake.stop();
    }
  };
}

const modelArgs = (fake: FakeModel) => ["--url", fake.url, "--model", "test-model", "--no-repo-map", "--no-sandbox"];

describe("print mode", () => {
  test("reads a file via a tool and returns JSON with exit code 0", withModel(
    [{ toolCalls: [{ name: "read_file", arguments: { path: "input.txt" } }] }, { text: "It says hi.", usage: { prompt: 20, completion: 4 } }],
    async (fake) => {
      fs.writeFileSync(path.join(project, "input.txt"), "hi\n");
      const run = await runCli(["-p", "--output-format", "json", ...modelArgs(fake), "--", "read input.txt"], { cwd: project, home });
      expect(run.code).toBe(0);
      const out = JSON.parse(run.stdout);
      expect(out.type).toBe("result");
      expect(out.subtype).toBe("success");
      expect(out.result).toBe("It says hi.");
      expect(out.num_turns).toBe(2);
      expect(out.usage.input_tokens).toBe(30);
      expect(out.denials).toBe(0);
      expect(fake.requests[1].messages.some((m: any) => m.role === "tool" && String(m.content).includes("hi"))).toBe(true);
    },
  ));

  test("a rejected write without a user is a denial: exit 3 and no file", withModel(
    [{ toolCalls: [{ name: "write_file", arguments: { path: "out.txt", content: "x" } }] }, { text: "I could not write it." }],
    async (fake) => {
      const run = await runCli(["-p", "--output-format", "json", ...modelArgs(fake), "--", "write out.txt"], { cwd: project, home });
      expect(run.code).toBe(3);
      expect(JSON.parse(run.stdout).denials).toBe(1);
      expect(fs.existsSync(path.join(project, "out.txt"))).toBe(false);
    },
  ));

  test("auto mode writes the file when --allow-auto is given", withModel(
    [{ toolCalls: [{ name: "write_file", arguments: { path: "made.txt", content: "made\n" } }] }, { text: "done" }],
    async (fake) => {
      const run = await runCli(["-p", "--mode", "auto", "--allow-auto", "--output-format", "json", ...modelArgs(fake), "--", "make it"], { cwd: project, home });
      expect(run.code).toBe(0);
      expect(fs.readFileSync(path.join(project, "made.txt"), "utf-8")).toBe("made\n");
    },
  ));

  test("auto mode without --allow-auto is refused", async () => {
    const run = await runCli(["-p", "--mode", "auto", "--", "anything"], { cwd: project, home });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--allow-auto");
  });

  test("max turns stops the loop with exit 2", withModel(
    [{ toolCalls: [{ name: "grep_files", arguments: { pattern: "x", path: "." } }] }],
    async (fake) => {
      const run = await runCli(["-p", "--max-turns", "2", "--output-format", "json", ...modelArgs(fake), "--", "loop"], { cwd: project, home });
      expect(run.code).toBe(2);
      expect(JSON.parse(run.stdout).subtype).toBe("error_max_turns");
    },
  ));

  test("--allowed-tools hides other tools from the model", withModel(
    [{ toolCalls: [{ name: "write_file", arguments: { path: "blocked.txt", content: "x" } }] }, { text: "ok" }],
    async (fake) => {
      const run = await runCli(["-p", "--allowed-tools", "read_file", "--output-format", "json", ...modelArgs(fake), "--", "try"], { cwd: project, home });
      expect(run.code).toBe(0);
      const names = fake.requests[0].tools.map((t: any) => t.function.name);
      expect(names).toEqual(["read_file"]);
      expect(fs.existsSync(path.join(project, "blocked.txt"))).toBe(false);
    },
  ));

  test("stream-json emits one JSON event per line ending with a result", withModel(
    [{ text: "streamed" }],
    async (fake) => {
      const run = await runCli(["-p", "--output-format", "stream-json", ...modelArgs(fake), "--", "stream"], { cwd: project, home });
      expect(run.code).toBe(0);
      const events = run.stdout.trim().split("\n").map((l) => JSON.parse(l));
      expect(events.some((e) => e.type === "text" && e.text === "streamed")).toBe(true);
      expect(events[events.length - 1].type).toBe("result");
    },
  ));

  test("reads the prompt from stdin", withModel(
    [{ text: "from stdin" }],
    async (fake) => {
      const run = await runCli(["-p", "--output-format", "json", ...modelArgs(fake)], { cwd: project, home, stdin: "piped task" });
      expect(run.code).toBe(0);
      expect(fake.requests[0].messages[fake.requests[0].messages.length - 1].content).toBe("piped task");
    },
  ));

  test("plan mode without a user rejects the plan and runs no tools", withModel(
    [{ text: "Step 1: edit the file." }],
    async (fake) => {
      const run = await runCli(["-p", "--mode", "plan", "--output-format", "json", ...modelArgs(fake), "--", "plan it"], { cwd: project, home });
      expect(run.code).toBe(0);
      expect(fake.requests[0].tools).toBeUndefined();
      expect(run.stderr).toContain("plan rejected");
    },
  ));

  test("--continue resumes the last session in this directory", withModel(
    [{ text: "first answer" }, { text: "second answer" }],
    async (fake) => {
      const dir = tempDir("llmcli-cont-");
      try {
        await runCli(["-p", "--output-format", "json", ...modelArgs(fake), "--", "first question"], { cwd: dir, home });
        const run = await runCli(["-p", "--continue", "--output-format", "json", ...modelArgs(fake), "--", "second question"], { cwd: dir, home });
        expect(run.code).toBe(0);
        const msgs = fake.requests[1].messages.map((m: any) => m.content);
        expect(msgs).toContain("first question");
        expect(msgs).toContain("first answer");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ));
});

describe("configuration trust", () => {
  test("project settings are ignored until trusted", async () => {
    const dir = tempDir("llmcli-trust-");
    try {
      fs.mkdirSync(path.join(dir, ".llmcli"));
      fs.writeFileSync(path.join(dir, ".llmcli", "settings.json"), JSON.stringify({ permissions: { allow: ["run_bash(*)"] }, repoMap: false }));
      const run = await runCli(["--show-config"], { cwd: dir, home });
      expect(run.code).toBe(0);
      const shown = JSON.parse(run.stdout);
      expect(shown.repoMap).toBe(false);
      expect(shown.permissions.allow).toEqual([]);
      expect(shown.projectTrustNeeded).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("headless runs warn that project settings were ignored", withModel(
    [{ text: "ok" }],
    async (fake) => {
      const dir = tempDir("llmcli-trust2-");
      try {
        fs.mkdirSync(path.join(dir, ".llmcli"));
        fs.writeFileSync(path.join(dir, ".llmcli", "settings.json"), JSON.stringify({ verifyCommand: "false" }));
        const run = await runCli(["-p", "--output-format", "json", ...modelArgs(fake), "--", "hi"], { cwd: dir, home });
        expect(run.stderr).toContain("project settings ignored");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ));
});

describe("entry points", () => {
  test("--version and --help work without a model", async () => {
    expect((await runCli(["--version"], { cwd: project, home })).stdout.trim()).toBe("0.3.0");
    expect((await runCli(["--help"], { cwd: project, home })).stdout).toContain("Exit codes");
  });

  test("unknown options fail with exit 1", async () => {
    const run = await runCli(["--bogus"], { cwd: project, home });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("unknown option");
  });

  test("--tool runs a tool directly", async () => {
    fs.writeFileSync(path.join(project, "t.txt"), "tool-direct\n");
    const run = await runCli(["--tool", "read_file", '{"path":"t.txt"}'], { cwd: project, home });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("tool-direct");
  });
});
