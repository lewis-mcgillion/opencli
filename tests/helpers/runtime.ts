import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Checkpoints } from "../../src/checkpoints";
import { DEFAULTS, type Config } from "../../src/config";
import { newSession, type Runtime } from "../../src/runtime";
import { sandboxStatus } from "../../src/sandbox";
import { fileTools } from "../../src/tools/files";
import { searchTools } from "../../src/tools/search";
import { shellTools } from "../../src/tools/shell";
import { webTools } from "../../src/tools/web";
import { planningTools } from "../../src/tools/planning";
import type { ChatRequest, Mode, ModelProvider, Ui } from "../../src/types";

export interface RecordingUi extends Ui {
  events: string[];
  questions: string[];
  previews: Array<{ title: string; body: string }>;
}

export function recordingUi(answer: boolean | null): RecordingUi {
  const ui: RecordingUi = {
    canAsk: answer !== null,
    events: [],
    questions: [],
    previews: [],
    text(chunk) { this.events.push(`text:${chunk}`); },
    info(line) { this.events.push(`info:${line}`); },
    warn(line) { this.events.push(`warn:${line}`); },
    error(line) { this.events.push(`error:${line}`); },
    toolStart(name) { this.events.push(`tool:${name}`); },
    toolEnd(name, firstLine, isError) { this.events.push(`toolEnd:${name}:${isError}:${firstLine}`); },
    preview(title, body) { this.previews.push({ title, body }); },
    async approve(question) {
      this.questions.push(question);
      return answer === true;
    },
    endMessage() {},
  };
  return ui;
}

export function stubProvider(): ModelProvider {
  return {
    name: "stub",
    async chat(_req: ChatRequest) {
      return { message: { role: "assistant", content: "stub" } };
    },
  };
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULTS, sources: [], sandbox: { ...DEFAULTS.sandbox, enabled: false }, ...overrides };
}

export function makeRuntime(cwd: string, ui: Ui, opts: { mode?: Mode; config?: Partial<Config> } = {}): Runtime {
  const config = makeConfig(opts.config);
  return {
    cwd,
    config,
    state: { mode: opts.mode ?? "regular", model: "test-model" },
    provider: stubProvider(),
    ui,
    session: newSession("test"),
    checkpoints: new Checkpoints(),
    sandbox: sandboxStatus({ ...config.sandbox, enabled: false }),
    tools: [...fileTools, ...shellTools, ...searchTools, ...webTools, ...planningTools],
    allowedTools: null,
    depth: 0,
    editedThisTurn: false,
    budget: {},
  };
}

export function tempDir(prefix = "llmcli-test-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
