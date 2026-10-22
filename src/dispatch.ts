import { findCommand, helpText, type Command, type CommandEnv } from "./commands/index";

export type Dispatch =
  | { kind: "exit" }
  | { kind: "output"; text: string }
  | { kind: "send"; text: string; allowedTools?: string[] };

export async function dispatchCommand(input: string, commands: Command[], env: CommandEnv): Promise<Dispatch> {
  if (input === "/exit" || input === "/quit") return { kind: "exit" };
  if (input === "/help") return { kind: "output", text: helpText(commands) };
  const [name, ...rest] = input.slice(1).split(/\s+/);
  const cmd = findCommand(name, commands);
  if (!cmd) return { kind: "output", text: `Unknown command /${name}. Try /help.` };
  try {
    const result = await cmd.run(rest.join(" "), env);
    if (typeof result === "string") return { kind: "output", text: result };
    return { kind: "send", text: result.send, allowedTools: result.allowedTools };
  } catch (e) {
    return { kind: "output", text: `Error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
