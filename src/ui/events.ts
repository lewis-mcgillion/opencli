import type { Ui } from "../types";

export class CollectUi implements Ui {
  readonly canAsk = false;
  private chunks: string[] = [];

  constructor(private readonly err: (s: string) => void) {}

  get output(): string {
    return this.chunks.join("");
  }

  text(chunk: string): void {
    this.chunks.push(chunk);
  }
  endMessage(): void {}
  info(line: string): void { this.err(`${line}\n`); }
  warn(line: string): void { this.err(`${line}\n`); }
  error(line: string): void { this.err(`${line}\n`); }
  toolStart(name: string, summary: string): void { this.err(`[${name}] ${summary}\n`); }
  toolEnd(_name: string, firstLine: string, isError: boolean): void {
    this.err(`  -> ${isError ? "error: " : ""}${firstLine}\n`);
  }
  preview(): void {}
  approve(): Promise<boolean> { return Promise.resolve(false); }
}

export class JsonLinesUi implements Ui {
  readonly canAsk = false;

  constructor(private readonly write: (line: string) => void) {}

  private emit(event: Record<string, unknown>): void {
    this.write(`${JSON.stringify(event)}\n`);
  }

  text(chunk: string): void { this.emit({ type: "text", text: chunk }); }
  endMessage(): void { this.emit({ type: "message_end" }); }
  info(line: string): void { this.emit({ type: "info", text: line }); }
  warn(line: string): void { this.emit({ type: "warning", text: line }); }
  error(line: string): void { this.emit({ type: "error", text: line }); }
  toolStart(name: string, summary: string): void { this.emit({ type: "tool_use", name, summary }); }
  toolEnd(name: string, firstLine: string, isError: boolean): void {
    this.emit({ type: "tool_result", name, is_error: isError, first_line: firstLine });
  }
  preview(title: string, body: string): void { this.emit({ type: "preview", title, body }); }
  approve(): Promise<boolean> { return Promise.resolve(false); }
  result(payload: Record<string, unknown>): void { this.emit({ type: "result", ...payload }); }
}
