import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { builtinCommands, type CommandEnv } from "../src/commands/index";
import { dispatchCommand } from "../src/dispatch";
import { makeRuntime, recordingUi, tempDir } from "./helpers/runtime";

let home: string;
let dir: string;
const savedHome = process.env.HOME;

beforeAll(() => {
  home = tempDir("llmcli-cmd-home-");
  dir = tempDir("llmcli-cmd-");
  process.env.HOME = home;
});
afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

function env(allowAuto = false): CommandEnv {
  const rt = makeRuntime(dir, recordingUi(null));
  rt.session.history.push({ role: "system", content: "sys" }, { role: "user", content: "hello" }, { role: "assistant", content: "hi there" });
  return { rt, allowAuto, mcpSummary: () => "No MCP servers connected." };
}

const commands = builtinCommands();
const run = (input: string, e: CommandEnv) => dispatchCommand(input, commands, e);

describe("slash commands", () => {
  test("/model shows and sets the model", async () => {
    const e = env();
    expect(await run("/model", e)).toEqual({ kind: "output", text: "model: test-model" });
    expect(await run("/model other-model", e)).toEqual({ kind: "output", text: "model set to other-model" });
    expect(e.rt.state.model).toBe("other-model");
  });

  test("/mode auto is refused without --allow-auto", async () => {
    const refused = await run("/mode auto", env(false));
    expect(refused).toMatchObject({ kind: "output" });
    expect((refused as { text: string }).text).toContain("--allow-auto");
    const e = env(true);
    expect(await run("/mode auto", e)).toEqual({ kind: "output", text: "mode set to auto" });
    expect(e.rt.state.mode).toBe("auto");
  });

  test("/save then /load round-trips the conversation", async () => {
    const e = env();
    expect(await run("/save roundtrip", e)).toEqual({ kind: "output", text: "saved roundtrip" });
    e.rt.session.history.splice(1);
    const loaded = await run("/load roundtrip", e);
    expect((loaded as { text: string }).text).toBe("loaded roundtrip (2 messages)");
    expect(e.rt.session.history.map((m) => m.content)).toEqual([e.rt.session.history[0].content, "hello", "hi there"]);
  });

  test("/load on a corrupt session reports an error instead of throwing", async () => {
    fs.mkdirSync(path.join(home, ".llmcli", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, ".llmcli", "sessions", "broken.json"), "{not json");
    const result = await run("/load broken", env());
    expect(result.kind).toBe("output");
    expect((result as { text: string }).text).toMatch(/^Error:/);
  });

  test("/save rejects path traversal", async () => {
    const result = await run("/save ../escape", env());
    expect((result as { text: string }).text).toMatch(/^Error:/);
    expect(fs.existsSync(path.join(home, ".llmcli", "escape.json"))).toBe(false);
  });

  test("/reset keeps only the system prompt", async () => {
    const e = env();
    await run("/reset", e);
    expect(e.rt.session.history.length).toBe(1);
  });

  test("/undo reports when there is nothing to revert", async () => {
    expect(await run("/undo", env())).toEqual({ kind: "output", text: "Nothing to undo." });
  });

  test("/usage reports token totals", async () => {
    const e = env();
    e.rt.session.usage = { input: 1200, output: 300 };
    expect(await run("/usage", e)).toEqual({ kind: "output", text: "input 1200 tokens, output 300 tokens" });
  });

  test("unknown commands and /exit", async () => {
    expect(await run("/nope", env())).toEqual({ kind: "output", text: "Unknown command /nope. Try /help." });
    expect((await run("/exit", env())).kind).toBe("exit");
  });

  test("/help lists the builtin commands", async () => {
    const help = await run("/help", env());
    expect((help as { text: string }).text).toContain("/compact");
    expect((help as { text: string }).text).toContain("/undo");
  });
});
