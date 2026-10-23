import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runTurn } from "../src/agent";
import { loadConfig } from "../src/config";
import { createOpenAIProvider } from "../src/model/openai";
import { executeTool } from "../src/execute";
import { buildRepoMap } from "../src/repomap";
import { loadCustomCommands, parseFrontmatter } from "../src/commands/custom";
import { validateSessionName } from "../src/session";
import { planCommand, sandboxStatus } from "../src/sandbox";
import { commandShell } from "../src/system-shell";
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
  const cfg = { enabled: "auto" as const, network: false, writable: [] as string[] };
  const linuxStatus = process.platform === "linux" ? sandboxStatus(cfg) : null;
  const linuxOnly = linuxStatus?.active ? test : test.skip;

  test("Linux status is unavailable when bwrap is missing", () => {
    const status = sandboxStatus(cfg, "linux", { findExecutable: () => null });
    expect(status.active).toBe(false);
    expect(status.backend).toBeNull();
    expect(status.reason).toContain("bwrap not found");
  });

  test("Linux status fails closed when installed bwrap cannot create namespaces", () => {
    const status = sandboxStatus({ ...cfg, enabled: true }, "linux", {
      findExecutable: () => "/usr/bin/bwrap",
      probeBubblewrap: () => "Operation not permitted",
    });
    expect(status.active).toBe(false);
    expect(status.backend).toBeNull();
    expect(status.reason).toContain("startup probe failed (Operation not permitted)");
    expect(status.reason).toContain("sandbox was required");
  });

  test("Linux status probes the selected network policy before reporting active", () => {
    let probedNetwork: boolean | undefined;
    const status = sandboxStatus({ ...cfg, network: true }, "linux", {
      findExecutable: () => "/usr/bin/bwrap",
      probeBubblewrap: (file, policy) => {
        expect(file).toBe("/usr/bin/bwrap");
        probedNetwork = policy.network;
        return null;
      },
    });
    expect(probedNetwork).toBe(true);
    expect(status.active).toBe(true);
    expect(status.reason).toContain("experimental; startup probe passed");
  });

  test("disabled and unsupported sandbox states are explicit without probing", () => {
    const checks = { findExecutable: () => { throw new Error("must not probe"); } };
    expect(sandboxStatus({ ...cfg, enabled: false }, "linux", checks).active).toBe(false);
    expect(sandboxStatus(cfg, "win32", checks).reason).toContain("no sandbox backend on win32");
    expect(sandboxStatus({ ...cfg, enabled: true }, "win32", checks).reason).toContain("sandbox was required");
  });

  for (const network of [false, true]) {
    test(`Linux plan ${network ? "allows" : "isolates"} shell/git network and preserves read-only root`, () => {
      const writable = tempDir("opencli-writable-");
      try {
        const plan = planCommand("git status", dir, { ...cfg, network, writable: [writable] }, { backend: "bwrap", active: true, reason: "injected" });
        expect(plan.file).toBe("bwrap");
        expect(plan.sandboxed).toBe(true);
        expect(plan.args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
        expect(plan.args.includes("--unshare-net")).toBe(!network);
        expect(plan.args).toContain("--die-with-parent");
        expect(plan.args).toContain(writable);
        expect(plan.args.slice(-3)).toEqual([commandShell(), "-c", "git status"]);
      } finally {
        fs.rmSync(writable, { recursive: true, force: true });
      }
    });
  }

  test("shared shell resolver falls back to bash or sh when zsh is unavailable", () => {
    expect(commandShell("/missing/zsh", (file) => file === "/bin/bash")).toBe("/bin/bash");
    expect(commandShell("/missing/zsh", (file) => file === "/bin/sh")).toBe("/bin/sh");
    expect(commandShell("/custom/fish", (file) => file === "/custom/fish" || file === "/bin/sh")).toBe("/bin/sh");
  });

  linuxOnly("Linux bwrap allows project writes and blocks writes outside configured writable roots", async () => {
    const outside = fs.mkdtempSync(path.join(os.homedir(), ".opencli-sandbox-test-"));
    try {
      const rt = makeRuntime(dir, recordingUi(null), { mode: "auto", config: { sandbox: cfg } });
      rt.sandbox = linuxStatus!;
      const inside = await executeTool(rt, "run_bash", JSON.stringify({ command: "echo ok > inside.txt && cat inside.txt" }));
      expect(inside.output).toContain("ok");
      expect(fs.readFileSync(path.join(dir, "inside.txt"), "utf8")).toBe("ok\n");
      const escaped = await executeTool(rt, "run_bash", JSON.stringify({ command: `echo bad > '${outside}/escape.txt'` }));
      expect(escaped.output).toContain("Exit");
      expect(fs.existsSync(path.join(outside, "escape.txt"))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  for (const network of [false, true]) {
    linuxOnly(`Linux bwrap ${network ? "allows" : "blocks"} shell and git access to a local HTTP server`, async () => {
      let hits = 0;
      const server = Bun.serve({ port: 0, fetch: () => { hits++; return new Response("reachable", { status: 404 }); } });
      try {
        const policy = { ...cfg, network };
        const rt = makeRuntime(dir, recordingUi(null), { mode: "auto", config: { sandbox: policy } });
        rt.sandbox = sandboxStatus(policy);
        expect(rt.sandbox.active).toBe(true);
        const url = `http://127.0.0.1:${server.port}/`;
        const script = `fetch(${JSON.stringify(url)}, {signal: AbortSignal.timeout(2000)}).then(r => r.text()).then(console.log).catch(() => process.exit(1))`;
        const shell = await executeTool(rt, "run_bash", JSON.stringify({ command: `'${process.execPath}' -e '${script}'` }));
        expect(shell.output.includes("reachable")).toBe(network);
        const shellHits = hits;
        await executeTool(rt, "git", JSON.stringify({ args: `-c http.proxy= -c http.connectTimeout=2 ls-remote ${url}` }));
        expect(hits > shellHits).toBe(network);
        if (!network) expect(hits).toBe(0);
      } finally {
        server.stop(true);
      }
    });
  }

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
    expect(plan.file).toBe(commandShell());
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

test("OpenCLI env vars override settings files, and provider defaults are applied", () => {
  const home = tempDir("opencli-cfg-home-");
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(dir, ".opencli"));
    fs.writeFileSync(path.join(dir, ".opencli", "settings.json"), JSON.stringify({ model: "from-file", url: "http://file/v1" }));
    const cfg = loadConfig({ cwd: dir, env: { OPENCLI_MODEL: "from-env", OPENCLI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" }, trustProject: true });
    expect(cfg.model).toBe("from-env");
    expect(cfg.url).toBe("http://file/v1");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.apiKey).toBe("key");
    const anthropic = loadConfig({ cwd: tempDir("opencli-cfg-empty-"), env: { OPENCLI_PROVIDER: "anthropic" } });
    expect(anthropic.url).toBe("https://api.anthropic.com/v1");
    const azure = loadConfig({ cwd: tempDir("opencli-cfg-azure-"), env: { OPENCLI_PROVIDER: "azure", AZURE_OPENAI_API_KEY: "az" } });
    expect(azure.url).toBe("https://YOUR-RESOURCE.openai.azure.com/openai/v1");
    expect(azure.apiKey).toBe("az");
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("legacy LLMCLI settings remain a fallback", () => {
  const home = tempDir("llmcli-cfg-home-");
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, ".llmcli"));
    fs.writeFileSync(path.join(home, ".llmcli", "config.json"), JSON.stringify({ model: "legacy-model" }));
    const cfg = loadConfig({ cwd: tempDir("opencli-legacy-empty-"), env: {} });
    expect(cfg.model).toBe("legacy-model");
  } finally {
    process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
