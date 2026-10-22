import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runTurn } from "../src/agent";
import { loadConfig } from "../src/config";
import { createOpenAIProvider } from "../src/model/openai";
import { executeTool } from "../src/execute";
import { buildRepoMap } from "../src/repomap";
import { loadCustomCommands, parseFrontmatter } from "../src/commands/custom";
import { validateSessionName } from "../src/session";
import { planCommand, sandboxStatus } from "../src/sandbox";
import { runSubagent } from "../src/agent";
import { startFakeModel, type FakeModel, type ScriptStep } from "./helpers/fake-model";
import { makeConfig, makeRuntime, recordingUi, tempDir } from "./helpers/runtime";
import type { Runtime } from "../src/runtime";

let dir: string;
beforeEach(() => {
  dir = tempDir("llmcli-feat-");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function withFake(script: ScriptStep[], body: (fake: FakeModel, rt: Runtime) => Promise<void>, configOverrides = {}) {
  return async () => {
    const fake = startFakeModel(script);
    try {
      const rt = makeRuntime(dir, recordingUi(null), { mode: "auto", config: configOverrides });
      rt.provider = createOpenAIProvider({ url: fake.url });
      rt.state.model = "test-model";
      rt.session.history.push({ role: "system", content: "sys" });
      await body(fake, rt);
    } finally {
      fake.stop();
    }
  };
}

describe("sandbox", () => {
  const macOnly = process.platform === "darwin" ? test : test.skip;

  macOnly("blocks writes outside the project and allows writes inside", async () => {
    const outside = path.join(process.env.HOME ?? "/tmp", ".llmcli-escape-test.txt");
    const status = sandboxStatus({ enabled: "auto", network: false, writable: [] });
    expect(status.active).toBe(true);
    const rt = makeRuntime(dir, recordingUi(null), { mode: "auto", config: { sandbox: { enabled: "auto", network: false, writable: [] } } });
    rt.sandbox = status;
    const inside = await executeTool(rt, "run_bash", JSON.stringify({ command: "echo ok > inside.txt && cat inside.txt" }));
    expect(inside.output).toContain("ok");
    const escaped = await executeTool(rt, "run_bash", JSON.stringify({ command: `echo bad > ${outside}` }));
    expect(escaped.output).toContain("Exit");
    expect(fs.existsSync(outside)).toBe(false);
  });

  macOnly("blocks outbound network when the policy denies it", async () => {
    const rt = makeRuntime(dir, recordingUi(null), { config: { sandbox: { enabled: "auto", network: false, writable: [] } } });
    rt.sandbox = sandboxStatus({ enabled: "auto", network: false, writable: [] });
    const server = Bun.serve({ port: 0, fetch: () => new Response("reachable") });
    try {
      const result = await executeTool(rt, "run_bash", JSON.stringify({ command: `curl -s -m 3 http://127.0.0.1:${server.port}/` }));
      expect(result.output).not.toContain("reachable");
    } finally {
      server.stop(true);
    }
  });

  test("planCommand is unsandboxed when no backend is active", () => {
    const plan = planCommand("echo hi", dir, { enabled: false, network: false, writable: [] }, { backend: null, active: false, reason: "off" });
    expect(plan.sandboxed).toBe(false);
    expect(plan.file).toBe("/bin/zsh");
  });
});

describe("hooks", () => {
  test("a pre_tool hook with exit 2 blocks the call and its message reaches the model", async () => {
    const rt = makeRuntime(dir, recordingUi(null), {
      mode: "auto",
      config: { hooks: { pre_tool: [{ tool: "write_file", command: "echo 'policy: no writes' >&2; exit 2" }], post_tool: [], on_stop: [] } },
    });
    const result = await executeTool(rt, "write_file", JSON.stringify({ path: "h.txt", content: "x" }));
    expect(result.denied).toBe(true);
    expect(result.output).toContain("policy: no writes");
    expect(fs.existsSync(path.join(dir, "h.txt"))).toBe(false);
  });

  test("hooks with a different tool filter are not run", async () => {
    const rt = makeRuntime(dir, recordingUi(null), {
      config: { hooks: { pre_tool: [{ tool: "run_bash", command: "exit 2" }], post_tool: [], on_stop: [] } },
    });
    const result = await executeTool(rt, "list_dir", JSON.stringify({ path: "." }));
    expect(result.isError).toBe(false);
  });
});

describe("verify loop", () => {
  test("a failing verify command is fed back and the agent fixes the problem", withFake(
    [
      { toolCalls: [{ name: "write_file", arguments: { path: "draft.txt", content: "draft\n" } }] },
      { text: "Drafted." },
      { toolCalls: [{ name: "write_file", arguments: { path: "ok.txt", content: "ready\n" } }] },
      { text: "Fixed." },
    ],
    async (fake, rt) => {
      rt.config = { ...rt.config, verifyCommand: "test -f ok.txt" };
      const result = await runTurn(rt, { maxSteps: 10 });
      expect(result.status).toBe("done");
      expect(fs.existsSync(path.join(dir, "ok.txt"))).toBe(true);
      const feedback = rt.session.history.find((m) => m.role === "user" && String(m.content).includes("failed"));
      expect(feedback).toBeDefined();
      expect(fake.requests.length).toBe(4);
    },
  ));
});

describe("subagents", () => {
  test("the task tool runs a read-only child turn and returns its answer", withFake(
    [
      { toolCalls: [{ name: "task", arguments: { prompt: "find the answer" } }] },
      { text: "the answer is 42" },
      { text: "Parent got: the answer is 42" },
    ],
    async (fake, rt) => {
      rt.runSubagent = (prompt, allowed) => runSubagent(rt, prompt, allowed);
      rt.tools = [...rt.tools];
      rt.session.history.push({ role: "user", content: "question" });
      const result = await runTurn(rt, { maxSteps: 5 });
      expect(result.status).toBe("done");
      const childTools = fake.requests[1].tools.map((t: any) => t.function.name);
      expect(childTools).toContain("read_file");
      expect(childTools).not.toContain("write_file");
      expect(childTools).not.toContain("task");
      expect(rt.session.history.at(-1)?.content).toBe("Parent got: the answer is 42");
    },
  ));
});

describe("budget", () => {
  test("stops with status budget once the estimated cost reaches the limit", withFake(
    [
      { toolCalls: [{ name: "list_dir", arguments: { path: "." } }], usage: { prompt: 1_000_000, completion: 0 } },
      { text: "never reached" },
    ],
    async (fake, rt) => {
      rt.config = { ...rt.config, prices: { "test-model": { inputPerMTok: 1, outputPerMTok: 1 } } };
      rt.budget = { maxCostUsd: 0.5, price: rt.config.prices["test-model"] };
      rt.session.history.push({ role: "user", content: "go" });
      const result = await runTurn(rt, { maxSteps: 10 });
      expect(result.status).toBe("budget");
      expect(fake.requests.length).toBe(1);
    },
  ));
});

describe("repository map", () => {
  test("lists top-level symbols per file and respects the budget", () => {
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "math.ts"), "export function add(a: number, b: number) { return a + b; }\nexport const PI = 3.14;\nfunction helper() {}\n");
    fs.writeFileSync(path.join(dir, "src", "tool.py"), "class Runner:\n    def run(self):\n        pass\n\ndef main():\n    pass\n");
    const map = buildRepoMap(dir);
    expect(map).toContain("src/math.ts: add, PI, helper");
    expect(map).toContain("src/tool.py: Runner, main");
    expect(buildRepoMap(dir, 10).length).toBeLessThanOrEqual(60);
  });
});

describe("custom commands and sessions", () => {
  test("frontmatter and $ARGUMENTS expand into a prompt with tool limits", () => {
    const cmdDir = path.join(dir, ".llmcli", "commands");
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, "review.md"), "---\ndescription: Review a file\nallowed-tools: read_file, grep_files\n---\nReview $ARGUMENTS carefully.\n");
    const cmds = loadCustomCommands(dir, new Set(["help"]));
    expect(cmds.map((c) => c.name)).toEqual(["review"]);
    const result = cmds[0].run("src/app.ts", {} as any);
    expect(result).toEqual({ send: "Review src/app.ts carefully.", allowedTools: ["read_file", "grep_files"] });
    expect(parseFrontmatter("---\ndescription: x\n---\nbody").meta.description).toBe("x");
  });

  test("custom commands cannot shadow builtins", () => {
    const cmdDir = path.join(dir, ".llmcli", "commands");
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, "model.md"), "hijack");
    expect(loadCustomCommands(dir, new Set(["model"]))).toEqual([]);
  });

  test("session names reject path traversal and separators", () => {
    expect(validateSessionName("good-name_1.v2")).toBe("good-name_1.v2");
    expect(() => validateSessionName("../etc")).toThrow();
    expect(() => validateSessionName("a/b")).toThrow();
    expect(() => validateSessionName("  ")).toThrow();
  });
});

test("env vars override settings files, and anthropic gets its default URL", () => {
  const home = tempDir("llmcli-cfg-home-");
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(dir, ".llmcli"));
    fs.writeFileSync(path.join(dir, ".llmcli", "settings.json"), JSON.stringify({ model: "from-file", url: "http://file/v1" }));
    const cfg = loadConfig({ cwd: dir, env: { LLMCLI_MODEL: "from-env", LLMCLI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" }, trustProject: true });
    expect(cfg.model).toBe("from-env");
    expect(cfg.url).toBe("http://file/v1");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.apiKey).toBe("key");
    const defaults = loadConfig({ cwd: tempDir("llmcli-cfg-empty-"), env: { LLMCLI_PROVIDER: "anthropic" } });
    expect(defaults.url).toBe("https://api.anthropic.com/v1");
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
