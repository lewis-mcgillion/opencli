import * as readline from "node:readline";
import { dispatchCommand } from "../dispatch";
import { submitMessage } from "../chat";
import type { App } from "../app";
import type { TextUi } from "./text";
import { ansi } from "./text";

const PROMPT = "\x1b[36m> \x1b[0m";
const CONT = "\x1b[2m...\x1b[0m ";

export function runRepl(app: App, opts: { modelLabel: string }): void {
  const { rt, commands, env } = app;
  const ui = rt.ui as TextUi;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });

  let pendingAnswer: ((answer: string) => void) | null = null;
  ui.attachApprover(
    (_question) => new Promise<boolean>((resolve) => {
      pendingAnswer = (answer) => resolve(/^y(es)?$/i.test(answer.trim()));
    }),
  );

  let pasteMode = false;
  const pasteBuffer: string[] = [];
  let continuation = "";
  let chain: Promise<void> = Promise.resolve();
  let inFlight: AbortController | null = null;

  const runMessage = async (text: string, allowedTools?: string[]) => {
    const controller = new AbortController();
    inFlight = controller;
    rt.signal = controller.signal;
    try {
      const result = await submitMessage(rt, text, allowedTools);
      if (result.status === "cancelled") ui.warn("[cancelled]");
    } catch (e: any) {
      ui.error(`Error: ${e?.message ?? e}`);
    } finally {
      inFlight = null;
      rt.signal = undefined;
    }
  };

  const handleLine = async (raw: string) => {
    if (pasteMode) {
      if (raw !== ".") {
        pasteBuffer.push(raw);
        process.stdout.write(CONT);
        return;
      }
      pasteMode = false;
      const text = pasteBuffer.join("\n").trim();
      pasteBuffer.length = 0;
      if (text) await runMessage(text);
      process.stdout.write(PROMPT);
      return;
    }
    if (raw.endsWith("\\")) {
      continuation += `${raw.slice(0, -1)}\n`;
      process.stdout.write(CONT);
      return;
    }
    const input = (continuation + raw).trim();
    continuation = "";
    if (!input) {
      process.stdout.write(PROMPT);
      return;
    }
    if (input === "/paste") {
      pasteMode = true;
      console.log("Paste mode. Type . on its own line to send:");
      process.stdout.write(CONT);
      return;
    }
    if (input.startsWith("/")) {
      const result = await dispatchCommand(input, commands, env);
      if (result.kind === "exit") {
        rl.close();
        return;
      }
      if (result.kind === "output") console.log(`${result.text}\n`);
      else await runMessage(result.text, result.allowedTools);
    } else {
      await runMessage(input);
    }
    process.stdout.write(PROMPT);
  };

  console.log(`${ansi.cyan("opencli")}  model: ${ansi.yellow(opts.modelLabel)}  mode: ${rt.state.mode}  sandbox: ${rt.sandbox.active ? rt.sandbox.backend : "off"}`);
  console.log("Type /help for commands, /paste for multi-line input.\n");

  rl.on("line", (raw) => {
    if (pendingAnswer) {
      const answer = pendingAnswer;
      pendingAnswer = null;
      answer(raw);
      return;
    }
    chain = chain.then(() => handleLine(raw));
  });
  rl.on("SIGINT", () => {
    if (inFlight) {
      inFlight.abort();
      process.stdout.write("\n");
      return;
    }
    rl.close();
  });
  rl.on("close", () => {
    chain.then(() => {
      app.mcp.stop();
      process.exit(0);
    });
  });
  process.stdout.write(PROMPT);
}
