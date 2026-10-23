import { dispatchCommand } from "../dispatch";
import { submitMessage } from "../chat";
import type { App } from "../app";
import type { Ui } from "../types";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export class TuiUi implements Ui {
  readonly canAsk = true;
  private lines: string[] = [];
  private live = "";
  private redraw: (() => void) | null = null;
  private asker: ((question: string) => Promise<boolean>) | null = null;

  attach(redraw: () => void, asker: (question: string) => Promise<boolean>): void {
    this.redraw = redraw;
    this.asker = asker;
  }

  private push(text: string): void {
    const parts = stripAnsi(this.live + text).split("\n");
    this.live = parts.pop() ?? "";
    this.lines.push(...parts);
    this.redraw?.();
  }

  private line(text: string): void {
    this.flush();
    this.lines.push(...stripAnsi(text).split("\n"));
    this.redraw?.();
  }

  private flush(): void {
    if (this.live) {
      this.lines.push(this.live);
      this.live = "";
    }
  }

  get content(): string {
    return [...this.lines, this.live].join("\n");
  }

  text(chunk: string): void { this.push(chunk); }
  endMessage(): void { this.flush(); this.redraw?.(); }
  info(line: string): void { this.line(line); }
  warn(line: string): void { this.line(line); }
  error(line: string): void { this.line(line); }
  toolStart(name: string, summary: string): void { this.line(`[${name}] ${summary}`); }
  toolEnd(_name: string, firstLine: string, isError: boolean): void { this.line(`  -> ${isError ? "error: " : ""}${firstLine}`); }
  preview(title: string, body: string): void { this.line(`${title}\n${body}`); }

  approve(question: string): Promise<boolean> {
    this.line(question);
    return this.asker ? this.asker(question) : Promise.resolve(false);
  }
}

export function runTui(app: App, ui: TuiUi, modelLabel: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const blessed = require("blessed") as any;
  const { rt, commands, env } = app;

  const screen = blessed.screen({ smartCSR: true, title: "opencli", fullUnicode: true });
  const logBox = blessed.log({
    top: 0, left: 0, right: 0, bottom: 6,
    border: { type: "line" },
    style: { border: { fg: "cyan" } },
    scrollable: true, alwaysScroll: true, mouse: true, keys: true,
    scrollbar: { ch: " ", track: { bg: "cyan" }, style: { inverse: true } },
  });
  const statusBar = blessed.box({ bottom: 5, left: 0, right: 0, height: 1, style: { bg: "blue", fg: "white" }, tags: true });
  const inputBox = blessed.textarea({
    bottom: 0, left: 0, right: 0, height: 5,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, focus: { border: { fg: "green" } } },
    inputOnFocus: true, mouse: true, keys: true,
  });
  screen.append(logBox);
  screen.append(statusBar);
  screen.append(inputBox);

  let frame = 0;
  let busy = false;
  let inFlight: AbortController | null = null;
  let spinner: ReturnType<typeof setInterval> | null = null;

  const renderLog = () => {
    logBox.setContent(ui.content);
    logBox.setScrollPerc(100);
    screen.render();
  };

  const updateStatus = () => {
    const spin = busy ? `${SPIN[frame++ % SPIN.length]} ` : "  ";
    const color = rt.state.mode === "auto" ? "red" : rt.state.mode === "plan" ? "yellow" : "green";
    const sandbox = rt.sandbox.active ? "sandbox" : "no sandbox";
    statusBar.setContent(
      ` ${spin}{cyan-fg}opencli{/}  model:{yellow-fg}${modelLabel}{/}  {${color}-fg}[${rt.state.mode.toUpperCase()}]{/}  ${sandbox}  {grey-fg}^C:cancel  ^D:exit  S-Tab:mode  Enter:send{/}`,
    );
    screen.render();
  };

  ui.attach(renderLog, (question) => new Promise<boolean>((resolve) => {
    const dialog = blessed.question({
      top: "center", left: "center", width: "60%", height: 7,
      border: { type: "line" },
      style: { border: { fg: "red" }, bg: "black" },
      mouse: true, keys: true,
    });
    screen.append(dialog);
    dialog.ask(`${question}\n\n[y/N]`, (_err: unknown, value: string) => {
      screen.remove(dialog);
      inputBox.focus();
      resolve(/^y(es)?$/i.test(value ?? ""));
      screen.render();
    });
    screen.render();
  }));

  const runMessage = async (text: string, allowedTools?: string[]) => {
    busy = true;
    inFlight = new AbortController();
    rt.signal = inFlight.signal;
    spinner = setInterval(updateStatus, 80);
    try {
      const result = await submitMessage(rt, text, allowedTools);
      if (result.status === "cancelled") ui.info("[cancelled]");
    } catch (e: any) {
      ui.error(`Error: ${e?.message ?? e}`);
    } finally {
      if (spinner) clearInterval(spinner);
      spinner = null;
      busy = false;
      inFlight = null;
      rt.signal = undefined;
      updateStatus();
      inputBox.focus();
    }
  };

  const submit = async () => {
    const text = (inputBox.getValue() as string).trim();
    inputBox.clearValue();
    screen.render();
    if (!text || busy) return;
    if (text.startsWith("/")) {
      const result = await dispatchCommand(text, commands, env);
      if (result.kind === "exit") shutdown();
      else if (result.kind === "output") ui.info(result.text);
      else await runMessage(result.text, result.allowedTools);
      return;
    }
    ui.info(`\n> ${text}`);
    await runMessage(text);
  };

  const cycleMode = () => {
    const modes = env.allowAuto ? ["regular", "plan", "auto"] : ["regular", "plan"];
    const next = modes[(modes.indexOf(rt.state.mode) + 1) % modes.length];
    rt.state.mode = next as typeof rt.state.mode;
    updateStatus();
    ui.info(`[mode: ${next}]`);
  };

  const shutdown = () => {
    if (spinner) clearInterval(spinner);
    app.mcp.stop();
    process.exit(0);
  };

  screen.key(["S-tab", "backtab"], cycleMode);
  inputBox.key(["S-tab", "backtab"], cycleMode);
  inputBox.key(["enter"], () => { void submit(); });
  inputBox.key(["escape"], () => { inputBox.clearValue(); screen.render(); });
  screen.key(["C-c"], () => {
    if (inFlight) inFlight.abort();
  });
  screen.key(["C-d"], shutdown);
  screen.key(["pageup"], () => { logBox.scroll(-(logBox.height as number)); screen.render(); });
  screen.key(["pagedown"], () => { logBox.scroll(logBox.height as number); screen.render(); });

  inputBox.focus();
  ui.info(`opencli  model: ${modelLabel}  mode: ${rt.state.mode}\nType /help for commands. Enter to send.\n`);
  updateStatus();
  screen.render();
}
