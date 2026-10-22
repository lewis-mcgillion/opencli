export type Mode = "regular" | "plan" | "auto";
export type OutputFormat = "text" | "json" | "stream-json";
export type ToolKind = "read" | "write" | "exec" | "network" | "meta";
export type JsonSchema = Record<string, any>;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface Usage {
  input: number;
  output: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onRetry?: (attempt: number, reason: string) => void;
}

export interface ChatResult {
  message: Message;
  usage?: Usage;
}

export interface ModelProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface Ui {
  readonly canAsk: boolean;
  text(chunk: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
  toolStart(name: string, summary: string): void;
  toolEnd(name: string, firstLine: string, isError: boolean): void;
  preview(title: string, body: string): void;
  approve(question: string): Promise<boolean>;
  endMessage(): void;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  denied: boolean;
}
