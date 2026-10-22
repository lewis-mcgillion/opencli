import * as fs from "node:fs";

type Snapshot = Map<string, string | null>;

export class Checkpoints {
  private open: Snapshot | null = null;
  private turns: Snapshot[] = [];

  constructor(private readonly limit = 50) {}

  record(absPath: string, previous: string | null): void {
    if (!this.open) this.open = new Map();
    if (!this.open.has(absPath)) this.open.set(absPath, previous);
  }

  commit(): void {
    if (this.open && this.open.size > 0) {
      this.turns.push(this.open);
      if (this.turns.length > this.limit) this.turns.shift();
    }
    this.open = null;
  }

  get depth(): number {
    return this.turns.length;
  }

  undo(): string[] | null {
    this.commit();
    const last = this.turns.pop();
    if (!last) return null;
    const restored: string[] = [];
    for (const [file, previous] of last) {
      if (previous === null) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        fs.writeFileSync(file, previous, "utf-8");
      }
      restored.push(file);
    }
    return restored;
  }
}
