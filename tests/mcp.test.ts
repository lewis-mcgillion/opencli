import { describe, test, expect, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../src/config";
import type { Ui } from "../src/types";
import { connectMcpServers, type McpHandle } from "../src/mcp/manager";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url));

function fakeServer(extra: Partial<McpServerConfig> = {}, env: Record<string, string> = {}): McpServerConfig {
  return {
    command: process.execPath,
    args: ["run", FIXTURE],
    env,
    ...extra,
  };
}

function recordingUi(): Ui & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    canAsk: false,
    warnings,
    text: () => {},
    info: () => {},
    warn: (line: string) => { warnings.push(line); },
    error: () => {},
    toolStart: () => {},
    toolEnd: () => {},
    preview: () => {},
    approve: async () => false,
    endMessage: () => {},
  };
}

const handles: McpHandle[] = [];
function track(h: McpHandle): McpHandle {
  handles.push(h);
  return h;
}

afterEach(() => {
  while (handles.length) handles.pop()!.stop();
});

function findTool(h: McpHandle, name: string) {
  const tool = h.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in ${h.tools.map((t) => t.name).join(", ")}`);
  return tool;
}

describe("MCP client and manager", () => {
  test("exposes echo (read) and fail (exec) tools and runs echo", async () => {
    const h = track(await connectMcpServers({ fake: fakeServer() }, recordingUi()));
    expect(findTool(h, "mcp__fake__echo").kind).toBe("read");
    expect(findTool(h, "mcp__fake__fail").kind).toBe("exec");
    expect(await findTool(h, "mcp__fake__echo").run({ text: "hi" }, null as any, { explicitAllow: false })).toBe("echo:hi");
  });

  test("fail tool returns an Error-prefixed string", async () => {
    const h = track(await connectMcpServers({ fake: fakeServer() }, recordingUi()));
    const out = await findTool(h, "mcp__fake__fail").run({}, null as any, { explicitAllow: false });
    expect(out.startsWith("Error: boom")).toBe(true);
  });

  test("allowTools restricts exposed tools", async () => {
    const h = track(await connectMcpServers({ fake: fakeServer({ allowTools: ["echo"] }) }, recordingUi()));
    const names = h.tools.map((t) => t.name);
    expect(names).toContain("mcp__fake__echo");
    expect(names).not.toContain("mcp__fake__fail");
  });

  test("reconnects once when the server crashes mid-call", async () => {
    const crashFile = join(tmpdir(), `fake-mcp-crash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const h = track(await connectMcpServers({ fake: fakeServer({}, { FAKE_MCP_CRASH_ONCE_FILE: crashFile }) }, recordingUi()));
    const out = await findTool(h, "mcp__fake__echo").run({ text: "x" }, null as any, { explicitAllow: false });
    expect(out).toBe("echo:x");
  });

  test("mcp_read_resource reads a resource from a server", async () => {
    const h = track(await connectMcpServers({ fake: fakeServer() }, recordingUi()));
    const out = await findTool(h, "mcp_read_resource").run(
      { server: "fake", uri: "mem://note" },
      null as any,
      { explicitAllow: false },
    );
    expect(out).toBe("note-body");
  });

  test("prompts become commands that send the rendered prompt", async () => {
    const h = track(await connectMcpServers({ fake: fakeServer() }, recordingUi()));
    const cmd = h.commands.find((c) => c.name === "fake:summarise");
    expect(cmd).toBeDefined();
    const result = await cmd!.run("topic=cats", {} as any);
    expect(result).toEqual({ send: "Summarise cats" });
  });

  test("a bad server is skipped with a warning and the good server still works", async () => {
    const ui = recordingUi();
    const h = track(
      await connectMcpServers(
        { broken: { command: "/nonexistent/bin" }, fake: fakeServer() },
        ui,
      ),
    );
    expect(ui.warnings.some((w) => w.includes("broken"))).toBe(true);
    expect(await findTool(h, "mcp__fake__echo").run({ text: "ok" }, null as any, { explicitAllow: false })).toBe("echo:ok");
  });

  test("a hung tools/call rejects with MCP timeout", async () => {
    const h = track(
      await connectMcpServers(
        { fake: fakeServer({ timeoutSeconds: 1 }, { FAKE_MCP_HANG: "1" }) },
        recordingUi(),
      ),
    );
    await expect(
      findTool(h, "mcp__fake__echo").run({ text: "x" }, null as any, { explicitAllow: false }),
    ).rejects.toThrow("MCP timeout");
  });
});
