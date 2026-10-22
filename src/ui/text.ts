import type { Ui } from "../types";

export const ansi = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export function colorDiff(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return ansi.green(line);
      if (line.startsWith("-") && !line.startsWith("---")) return ansi.red(line);
      if (line.startsWith("@@")) return ansi.cyan(line);
      return ansi.dim(line);
    })
    .join("\n");
}

export interface TextUiOptions {
  out: (s: string) => void;
  err: (s: string) => void;
  color: boolean;
}

export class TextUi implements Ui {
  private open = false;
  private approver: ((question: string) => Promise<boolean>) | null = null;

  constructor(private readonly opts: TextUiOptions) {}

  attachApprover(fn: (question: string) => Promise<boolean>): void {
    this.approver = fn;
  }

  get canAsk(): boolean {
    return this.approver !== null;
  }

  private paint(fn: (s: string) => string, s: string): string {
    return this.opts.color ? fn(s) : s;
  }

  text(chunk: string): void {
    if (!chunk) return;
    this.open = !chunk.endsWith("\n");
    this.opts.out(this.paint(ansi.green, chunk));
  }

  endMessage(): void {
    if (this.open) this.opts.out("\n");
    this.open = false;
  }

  info(line: string): void {
    this.opts.err(`${this.paint(ansi.dim, line)}\n`);
  }

  warn(line: string): void {
    this.opts.err(`${this.paint(ansi.yellow, line)}\n`);
  }

  error(line: string): void {
    this.opts.err(`${this.paint(ansi.red, line)}\n`);
  }

  toolStart(name: string, summary: string): void {
    this.opts.err(`${this.paint(ansi.yellow, `[${name}]`)} ${summary}\n`);
  }

  toolEnd(_name: string, firstLine: string, isError: boolean): void {
    const line = `  -> ${firstLine}`;
    this.opts.err(`${this.paint(isError ? ansi.red : ansi.dim, line)}\n`);
  }

  preview(title: string, body: string): void {
    this.opts.out(`\n${this.paint(ansi.cyan, title)}\n${this.opts.color ? colorDiff(body) : body}\n`);
  }

  async approve(question: string): Promise<boolean> {
    if (!this.approver) return false;
    this.opts.out(`\n${this.paint(ansi.red, question)} [y/N] `);
    return this.approver(question);
  }
}
