import { spawn, type ChildProcess } from "node:child_process";
import type { McpServerConfig } from "../config";

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_TIMEOUT_SECONDS = 60;
const METHOD_NOT_FOUND = -32601;

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  proc: ChildProcess;
  buffer: string;
  stderr: string;
  alive: boolean;
  pending: Map<number, Pending>;
}

export class McpRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

export class McpClient {
  private session: Session | null = null;
  private nextId = 1;
  private stopped = false;
  private starting: Promise<void> | null = null;

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  /** Spawn the server and perform the initialize handshake. */
  async connect(): Promise<void> {
    if (this.stopped) throw new Error(`MCP server stopped: ${this.name}`);
    if (this.session?.alive) return;
    if (this.starting) return this.starting;
    this.starting = this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async open(): Promise<void> {
    const env = { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>;
    let proc: ChildProcess;
    try {
      proc = spawn(this.config.command, this.config.args ?? [], { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e: any) {
      throw new Error(`MCP server "${this.name}" failed to start: ${e.message}`);
    }

    const session: Session = { proc, buffer: "", stderr: "", alive: true, pending: new Map() };
    this.session = session;

    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => this.onData(session, chunk));
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (chunk: string) => {
      session.stderr = (session.stderr + chunk).slice(-500);
    });
    proc.stdin?.on("error", () => this.markDead(session, "stdin error"));
    proc.on("error", (e) => this.markDead(session, `process error: ${e.message}`));
    proc.on("exit", (code, signal) => this.markDead(session, `process exited (${signal ?? code})`));

    try {
      await this.rawRequest(session, "initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "llmcli", version: "0.3.0" },
      });
      this.notify(session, "notifications/initialized", {});
    } catch (e: any) {
      this.markDead(session, e.message);
      proc.kill("SIGTERM");
      const tail = session.stderr.trim();
      throw new Error(`MCP server "${this.name}" failed to initialize: ${e.message}${tail ? ` (stderr: ${tail})` : ""}`);
    }
  }

  private onData(session: Session, chunk: string): void {
    session.buffer += chunk;
    let idx: number;
    while ((idx = session.buffer.indexOf("\n")) !== -1) {
      const line = session.buffer.slice(0, idx).trim();
      session.buffer = session.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON: ignore
      }
      if (msg === null || typeof msg !== "object") continue;
      if (msg.id === undefined || msg.id === null) continue; // notification
      const pending = session.pending.get(msg.id);
      if (!pending) continue;
      session.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new McpRpcError(msg.error.code ?? -1, String(msg.error.message ?? "unknown error")));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private markDead(session: Session, reason: string): void {
    if (!session.alive) return;
    session.alive = false;
    for (const [id, p] of session.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP server "${this.name}" ${reason} during ${p.method}`));
      session.pending.delete(id);
    }
  }

  private write(session: Session, payload: object): void {
    if (!session.alive || !session.proc.stdin || session.proc.stdin.destroyed) {
      throw new Error(`MCP server "${this.name}" is not running`);
    }
    const ok = session.proc.stdin.write(JSON.stringify(payload) + "\n");
    if (!ok && session.proc.stdin.writableLength === 0 && session.proc.stdin.destroyed) {
      throw new Error(`MCP server "${this.name}" stdin closed`);
    }
  }

  private notify(session: Session, method: string, params: object): void {
    this.write(session, { jsonrpc: "2.0", method, params });
  }

  private rawRequest(session: Session, method: string, params: object): Promise<any> {
    const id = this.nextId++;
    const timeoutMs = (this.config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (session.pending.delete(id)) reject(new Error(`MCP timeout: ${method}`));
      }, timeoutMs);
      session.pending.set(id, { method, resolve, reject, timer });
      try {
        this.write(session, { jsonrpc: "2.0", id, method, params });
      } catch (e) {
        session.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /**
   * Send a request. If the process has died or the write fails, respawn once
   * (re-initialising) and retry the request a single time.
   */
  private async request(method: string, params: object): Promise<any> {
    if (this.stopped) throw new Error("MCP server stopped");
    await this.connect();
    try {
      return await this.rawRequest(this.session!, method, params);
    } catch (e: any) {
      if (this.stopped) throw new Error("MCP server stopped");
      if (e instanceof McpRpcError || String(e.message).startsWith("MCP timeout")) throw e;
      // Process gone or write failed: reconnect and retry exactly once.
      this.session?.proc.kill("SIGTERM");
      this.session = null;
      await this.connect();
      return this.rawRequest(this.session!, method, params);
    }
  }

  /** Returns [] when the server does not implement the list method. */
  private async list(method: string, key: string): Promise<any[]> {
    try {
      const result = await this.request(method, {});
      const items = result?.[key];
      return Array.isArray(items) ? items : [];
    } catch (e) {
      if (e instanceof McpRpcError && e.code === METHOD_NOT_FOUND) return [];
      throw e;
    }
  }

  listTools(): Promise<any[]> {
    return this.list("tools/list", "tools");
  }

  listResources(): Promise<any[]> {
    return this.list("resources/list", "resources");
  }

  listPrompts(): Promise<any[]> {
    return this.list("prompts/list", "prompts");
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = await this.request("tools/call", { name, arguments: args ?? {} });
    if (result?.isError) {
      return `Error: ${textOf(result.content) || JSON.stringify(result)}`;
    }
    const text = textOf(result?.content);
    return text || JSON.stringify(result);
  }

  async readResource(uri: string): Promise<string> {
    const result = await this.request("resources/read", { uri });
    const contents: any[] = Array.isArray(result?.contents) ? result.contents : [];
    const parts = contents.map((c) => {
      if (typeof c?.text === "string") return c.text;
      if (typeof c?.blob === "string") return `(binary resource ${c.uri ?? uri}: ${c.blob.length} base64 chars)`;
      return "";
    });
    return parts.filter(Boolean).join("\n");
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const result = await this.request("prompts/get", { name, arguments: args });
    const messages: any[] = Array.isArray(result?.messages) ? result.messages : [];
    return messages
      .map((m) => (typeof m?.content?.text === "string" ? m.content.text : ""))
      .filter(Boolean)
      .join("\n\n");
  }

  /** Kill the process and reject everything in flight. */
  stop(): void {
    this.stopped = true;
    const session = this.session;
    this.session = null;
    if (!session) return;
    for (const [id, p] of session.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP server stopped"));
      session.pending.delete(id);
    }
    session.alive = false;
    session.proc.kill("SIGTERM");
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}
