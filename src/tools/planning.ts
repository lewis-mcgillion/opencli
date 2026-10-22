import type { Runtime, ToolDef } from "../runtime";

const READ_ONLY_TOOLS = ["read_file", "list_dir", "glob_files", "grep_files", "web_fetch", "todo_write", "bash_output"];

export const planningTools: ToolDef[] = [
  {
    name: "todo_write",
    description: "Track steps of a multi-step task. Replaces the current todo list.",
    kind: "meta",
    parameters: {
      type: "object",
      properties: { todos: { type: "array", items: { type: "string" }, description: "List of todo items" } },
      required: ["todos"],
    },
    run: async (args, rt: Runtime) => {
      rt.session.todos = Array.isArray(args.todos) ? args.todos.map(String) : [];
      return rt.session.todos.map((t, i) => `${i + 1}. ${t}`).join("\n") || "(empty)";
    },
  },
  {
    name: "task",
    description: "Delegate a self-contained question to a subagent with read-only tools. It returns the subagent's final answer. Use it for broad searches that would fill the main context.",
    kind: "meta",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "Complete instructions for the subagent" } },
      required: ["prompt"],
    },
    run: async (args, rt) => {
      if (!rt.runSubagent) throw new Error("subagents are not available here");
      return rt.runSubagent(String(args.prompt ?? ""), new Set(READ_ONLY_TOOLS));
    },
  },
];
