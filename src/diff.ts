export interface DiffResult {
  text: string;
  added: number;
  removed: number;
}

const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

type Op = { kind: " " | "+" | "-"; line: string };

function lineOps(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: " ", line: a[i] }); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { ops.push({ kind: "-", line: a[i] }); i++; }
    else { ops.push({ kind: "+", line: b[j] }); j++; }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] });
  while (j < m) ops.push({ kind: "+", line: b[j++] });
  return ops;
}

export function diffText(before: string, after: string, label: string): DiffResult {
  if (before === after) return { text: "", added: 0, removed: 0 };
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const ops = lineOps(a, b);
  let added = 0;
  let removed = 0;
  if (!ops) {
    added = b.length;
    removed = a.length;
    return { text: `--- ${label}\n+++ ${label}\n(file too large to preview: -${removed} +${added} lines)`, added, removed };
  }
  for (const op of ops) {
    if (op.kind === "+") added++;
    if (op.kind === "-") removed++;
  }

  const out: string[] = [`--- ${label}`, `+++ ${label}`];
  const changed = ops.map((op, idx) => (op.kind !== " " ? idx : -1)).filter((idx) => idx >= 0);
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - CONTEXT);
    let end = changed[k];
    while (k + 1 < changed.length && changed[k + 1] - end <= 2 * CONTEXT) {
      k++;
      end = changed[k];
    }
    const stop = Math.min(ops.length - 1, end + CONTEXT);
    out.push(`@@ ${start + 1}-${stop + 1} @@`);
    for (let idx = start; idx <= stop; idx++) out.push(`${ops[idx].kind}${ops[idx].line}`);
    k++;
  }
  return { text: out.join("\n"), added, removed };
}
