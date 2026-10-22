import { runAdvisoryHooks } from "./hooks";
import { compactHistory, elideOldToolOutputs, needsCompaction } from "./context";
import { executeTool } from "./execute";
import { costOf, newSession, type Runtime, type ToolDef } from "./runtime";
import { recoverTextToolCalls } from "./model/fallback";
import { runVerify } from "./verify";
import type { ToolSpec, Ui } from "./types";

export interface TurnOptions {
  maxSteps?: number;
  allowedTools?: Set<string> | null;
}

export interface TurnResult {
  status: "done" | "max_steps" | "budget" | "cancelled";
  steps: number;
}

const DEFAULT_MAX_STEPS = 40;
const MAX_VERIFY_ATTEMPTS = 2;

function isAbort(e: any): boolean {
  return e?.name === "AbortError";
}

function intersect(a: Set<string> | null, b: Set<string> | null): Set<string> | null {
  if (!a) return b;
  if (!b) return a;
  return new Set([...a].filter((x) => b.has(x)));
}

function summarizeArgs(argsJson: string): string {
  try {
    const a = JSON.parse(argsJson);
    return String(a.path ?? a.command ?? a.pattern ?? a.url ?? a.args ?? a.job ?? a.prompt ?? "").replace(/\s+/g, " ").slice(0, 70);
  } catch {
    return "";
  }
}

export function toolSpecs(tools: ToolDef[], allowed: Set<string> | null): ToolSpec[] {
  return tools
    .filter((t) => !allowed || allowed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export async function runTurn(rt: Runtime, opts: TurnOptions = {}): Promise<TurnResult> {
  const maxSteps = opts.maxSteps ?? rt.budget.maxSteps ?? DEFAULT_MAX_STEPS;
  const allowed = intersect(rt.allowedTools, opts.allowedTools ?? null);
  const specs = toolSpecs(rt.tools, allowed);
  const history = rt.session.history;
  let verifyAttempts = 0;
  rt.editedThisTurn = false;

  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (rt.budget.maxCostUsd !== undefined && costOf(rt.session.usage, rt.budget.price) >= rt.budget.maxCostUsd) {
        rt.ui.warn(`[stopped: cost limit of $${rt.budget.maxCostUsd} reached]`);
        return { status: "budget", steps: step - 1 };
      }
      if (needsCompaction(history, rt.config.contextWindow)) {
        try {
          const done = await compactHistory(rt.provider, rt.state.model, history, rt.signal);
          if (done) rt.ui.info(`[compacted ${done.removed} messages into a summary]`);
        } catch (e: any) {
          if (isAbort(e)) return { status: "cancelled", steps: step };
          rt.ui.warn(`[compaction failed: ${e.message}]`);
        }
      }
      elideOldToolOutputs(history);

      let message;
      try {
        const result = await rt.provider.chat({
          model: rt.state.model,
          messages: history,
          tools: specs,
          signal: rt.signal,
          onText: (t) => rt.ui.text(t),
          onRetry: (attempt, reason) => rt.ui.info(`[retrying: attempt ${attempt}, ${reason}]`),
        });
        message = result.message;
        if (result.usage) {
          rt.session.usage.input += result.usage.input;
          rt.session.usage.output += result.usage.output;
        }
      } catch (e: any) {
        if (isAbort(e)) return { status: "cancelled", steps: step };
        throw e;
      }

      if (!message.tool_calls?.length && specs.length) {
        const recovered = recoverTextToolCalls(message.content ?? "", specs);
        if (recovered) {
          message.tool_calls = recovered;
          rt.ui.info("[recovered a tool call that the model wrote as text]");
        }
      }
      history.push(message);
      rt.ui.endMessage();

      if (!message.tool_calls?.length) {
        if (rt.editedThisTurn && rt.config.verifyCommand && verifyAttempts < MAX_VERIFY_ATTEMPTS) {
          verifyAttempts++;
          rt.editedThisTurn = false;
          const verdict = await runVerify(rt.config.verifyCommand, rt.cwd, rt.signal);
          rt.ui.info(`[verify ${verdict.ok ? "passed" : "failed"}: ${rt.config.verifyCommand}]`);
          if (!verdict.ok) {
            history.push({
              role: "user",
              content: `The verification command \`${rt.config.verifyCommand}\` failed:\n${verdict.output}\nFix the problem.`,
            });
            continue;
          }
        }
        const notes = await runAdvisoryHooks(rt.config.hooks.on_stop, { event: "on_stop", cwd: rt.cwd });
        for (const note of notes) rt.ui.warn(`[${note}]`);
        return { status: "done", steps: step };
      }

      for (const call of message.tool_calls) {
        const name = call.function.name;
        rt.ui.toolStart(name, summarizeArgs(call.function.arguments));
        const result = await executeTool(rt, name, call.function.arguments);
        rt.ui.toolEnd(name, result.output.split("\n")[0].slice(0, 100), result.isError);
        history.push({ role: "tool", tool_call_id: call.id, name, content: result.output });
      }
    }
    rt.ui.warn(`[stopped after ${maxSteps} steps]`);
    return { status: "max_steps", steps: maxSteps };
  } finally {
    rt.checkpoints.commit();
  }
}

class SubagentUi implements Ui {
  constructor(private readonly parent: Ui) {}
  get canAsk(): boolean { return this.parent.canAsk; }
  text(): void {}
  info(line: string): void { this.parent.info(`  | ${line}`); }
  warn(line: string): void { this.parent.warn(`  | ${line}`); }
  error(line: string): void { this.parent.error(`  | ${line}`); }
  toolStart(name: string, summary: string): void { this.parent.info(`  | [${name}] ${summary}`); }
  toolEnd(): void {}
  preview(): void {}
  approve(question: string): Promise<boolean> { return this.parent.approve(question); }
  endMessage(): void {}
}

export async function runSubagent(parent: Runtime, prompt: string, allowed: Set<string>): Promise<string> {
  const systemPrompt = parent.session.history[0];
  const child: Runtime = {
    ...parent,
    session: {
      ...newSession(`${parent.session.id}-sub`),
      history: [systemPrompt, { role: "user", content: prompt }],
    },
    ui: new SubagentUi(parent.ui),
    allowedTools: intersect(parent.allowedTools, allowed),
    depth: parent.depth + 1,
    editedThisTurn: false,
    runSubagent: undefined,
  };
  const result = await runTurn(child, { maxSteps: 15 });
  parent.session.usage.input += child.session.usage.input;
  parent.session.usage.output += child.session.usage.output;
  const last = [...child.session.history].reverse().find((m) => m.role === "assistant");
  const answer = last?.content?.trim() || "(subagent returned no answer)";
  return result.status === "done" ? answer : `${answer}\n[subagent stopped: ${result.status}]`;
}
