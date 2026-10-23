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

async function runCli(args: string[], opts: { cwd: string; home: string; stdin?: string; env?: NodeJS.ProcessEnv }): Promise<Run> {
  const proc = Bun.spawn([process.execPath, "run", MAIN, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, HOME: opts.home, LLMCLI_MODEL: "test-model", LLMCLI_URL: "", ...opts.env },
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
    const help = (await runCli(["--help"], { cwd: project, home })).stdout;
    expect(help).toContain("opencli");
    expect(help).toContain("Exit codes");
  });

  test("models list shows provider profiles", async () => {
    const run = await runCli(["models", "list"], { cwd: project, home });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("azure-openai");
    expect(run.stdout).toContain("local-openai");
  });

  test("models list and show include persisted custom profiles and source metadata", async () => {
    const dir = tempDir("opencli-models-");
    const profileHome = tempDir("opencli-models-home-");
    try {
      fs.mkdirSync(path.join(profileHome, ".opencli"));
      fs.mkdirSync(path.join(dir, ".opencli"));
      fs.writeFileSync(path.join(profileHome, ".opencli", "config.json"), JSON.stringify({ modelProfiles: { personal: { url: "http://localhost:9000/v1" } } }));
      fs.writeFileSync(path.join(dir, ".opencli", "settings.json"), JSON.stringify({ modelProfiles: { foundry: { provider: "azure", model: "deployment", apiKeyEnv: "FOUNDRY_KEY", contextWindow: 96000 } } }));
      const opts = { cwd: dir, home: profileHome, env: { FOUNDRY_KEY: "never-display-this-secret" } };
      const list = await runCli(["models", "list"], opts);
      expect(list.code).toBe(0);
      expect(list.stdout).toContain("builtin");
      expect(list.stdout).toContain("personal");
      expect(list.stdout).toContain("user");
      expect(list.stdout).toContain("foundry");
      expect(list.stdout).toContain("project");
      const shown = await runCli(["models", "show", "foundry"], opts);
      expect(shown.code).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({ id: "foundry", source: "project", provider: "azure", model: "deployment", apiKeyEnv: "FOUNDRY_KEY", contextWindow: 96000 });
      expect(shown.stdout).not.toContain("never-display-this-secret");
      const builtin = await runCli(["models", "show", "anthropic"], opts);
      expect(JSON.parse(builtin.stdout).source).toBe("builtin");
      const missing = await runCli(["models", "show", "unknown"], opts);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("unknown model profile unknown");
      const noId = await runCli(["models", "show"], opts);
      expect(noId.code).toBe(1);
      expect(noId.stderr).toContain("models show needs a profile id");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(profileHome, { recursive: true, force: true });
    }
  });

  test("models test uses custom Azure deployment and API key environment metadata", async () => {
    const dir = tempDir("opencli-models-test-");
    const profileHome = tempDir("opencli-models-test-home-");
    const seen: { key: string | null; authorization: string | null; body: any }[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      seen.push({ key: req.headers.get("api-key"), authorization: req.headers.get("authorization"), body: await req.json() });
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      fs.mkdirSync(path.join(dir, ".opencli"));
      fs.writeFileSync(path.join(dir, ".opencli", "settings.json"), JSON.stringify({ modelProfiles: { foundry: { provider: "azure", model: "custom-deployment", url: `http://localhost:${server.port}/v1`, apiKeyEnv: "FOUNDRY_KEY" } } }));
      const run = await runCli(["models", "test", "foundry"], { cwd: dir, home: profileHome, env: { OPENCLI_MODEL: "", LLMCLI_MODEL: "", OPENCLI_URL: "", LLMCLI_URL: "", OPENCLI_API_KEY: "", LLMCLI_API_KEY: "", FOUNDRY_KEY: "azure-secret" } });
      expect(run.code).toBe(0);
      expect(run.stdout.trim()).toBe("foundry: ok");
      expect(seen).toHaveLength(1);
      expect(seen[0].key).toBe("azure-secret");
      expect(seen[0].authorization).toBeNull();
      expect(seen[0].body.model).toBe("custom-deployment");
    } finally {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(profileHome, { recursive: true, force: true });
    }
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
