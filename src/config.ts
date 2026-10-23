import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { mergeModelProfiles, type CustomModelProfile, type ModelProfile, type ProviderName } from "./model/profiles";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutSeconds?: number;
  allowTools?: string[];
}

export interface HookSpec {
  tool?: string;
  command: string;
}

export interface Permissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface Prices {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface Config {
  provider: ProviderName;
  model: string;
  modelProfiles: Record<string, ModelProfile>;
  url: string;
  apiKey?: string;
  contextWindow: number;
  maxOutputTokens: number;
  repoMap: boolean;
  tui: boolean;
  sandbox: { enabled: boolean | "auto"; network: boolean; writable: string[] };
  permissions: Permissions;
  mcpServers: Record<string, McpServerConfig>;
  hooks: { pre_tool: HookSpec[]; post_tool: HookSpec[]; on_stop: HookSpec[] };
  verifyCommand?: string;
  prices: Record<string, Prices>;
  trusted: boolean;
  projectTrustNeeded: boolean;
  sources: string[];
}

type RawConfig = Partial<Omit<Config, "permissions" | "hooks" | "sandbox" | "modelProfiles">> & {
  modelProfiles?: Record<string, CustomModelProfile>;
  permissions?: Partial<Permissions>;
  hooks?: Partial<Record<keyof Config["hooks"], HookSpec[]>>;
  sandbox?: Partial<Config["sandbox"]>;
};

const TRUST_KEYS = ["provider", "url", "apiKey", "modelProfiles", "prices", "mcpServers", "hooks", "verifyCommand", "permissions", "sandbox"] as const;

export const DEFAULTS: Config = {
  provider: "openai",
  model: "gemma4:e4b",
  modelProfiles: {},
  url: "http://localhost:11434/v1",
  contextWindow: 32768,
  maxOutputTokens: 8192,
  repoMap: true,
  tui: true,
  sandbox: { enabled: "auto", network: false, writable: [] },
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: {},
  hooks: { pre_tool: [], post_tool: [], on_stop: [] },
  prices: {},
  trusted: false,
  projectTrustNeeded: false,
  sources: [],
};

export function userConfigDir(): string {
  const home = process.env.HOME ?? os.homedir();
  const opencli = path.join(home, ".opencli");
  if (fs.existsSync(opencli) || !fs.existsSync(path.join(home, ".llmcli"))) return opencli;
  return path.join(home, ".llmcli");
}

function readJson(file: string): RawConfig | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as RawConfig;
  } catch (e: any) {
    throw new Error(`cannot read ${file}: ${e.message}`);
  }
}

function pickExecutable(raw: RawConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TRUST_KEYS) if (raw[k as keyof RawConfig] !== undefined) out[k] = raw[k as keyof RawConfig];
  return out;
}

export function projectFingerprint(projectRaw: RawConfig, localRaw: RawConfig | null): string {
  const payload = JSON.stringify({ project: pickExecutable(projectRaw), local: localRaw ? pickExecutable(localRaw) : null });
  return createHash("sha256").update(payload).digest("hex");
}

function trustFile(): string {
  return path.join(userConfigDir(), "trust.json");
}

export function isProjectTrusted(cwd: string, fingerprint: string): boolean {
  try {
    const store = JSON.parse(fs.readFileSync(trustFile(), "utf-8")) as Record<string, string>;
    return store[fs.realpathSync(cwd)] === fingerprint;
  } catch {
    return false;
  }
}

export function trustProject(cwd: string, fingerprint: string): void {
  fs.mkdirSync(userConfigDir(), { recursive: true });
  let store: Record<string, string> = {};
  try { store = JSON.parse(fs.readFileSync(trustFile(), "utf-8")); } catch {}
  store[fs.realpathSync(cwd)] = fingerprint;
  fs.writeFileSync(trustFile(), JSON.stringify(store, null, 2));
}

function mergeLayer(base: Config, layer: RawConfig, label: string): Config {
  const next: Config = { ...base, sources: [...base.sources, label] };
  if (layer.provider) next.provider = layer.provider;
  if (layer.model) next.model = layer.model;
  if (layer.modelProfiles !== undefined) {
    const source = label.startsWith("project") ? "project" : label === "local" ? "local" : "user";
    next.modelProfiles = mergeModelProfiles(base.modelProfiles, layer.modelProfiles, source);
  }
  if (layer.url) next.url = layer.url;
  if (layer.apiKey) next.apiKey = layer.apiKey;
  if (layer.contextWindow) next.contextWindow = layer.contextWindow;
  if (layer.maxOutputTokens) next.maxOutputTokens = layer.maxOutputTokens;
  if (layer.repoMap !== undefined) next.repoMap = layer.repoMap;
  if (layer.tui !== undefined) next.tui = layer.tui;
  if (layer.verifyCommand) next.verifyCommand = layer.verifyCommand;
  if (layer.prices) next.prices = { ...base.prices, ...layer.prices };
  if (layer.mcpServers) next.mcpServers = { ...base.mcpServers, ...layer.mcpServers };
  if (layer.sandbox) {
    next.sandbox = {
      enabled: layer.sandbox.enabled ?? base.sandbox.enabled,
      network: layer.sandbox.network ?? base.sandbox.network,
      writable: [...base.sandbox.writable, ...(layer.sandbox.writable ?? [])],
    };
  }
  if (layer.permissions) {
    next.permissions = {
      allow: [...base.permissions.allow, ...(layer.permissions.allow ?? [])],
      ask: [...base.permissions.ask, ...(layer.permissions.ask ?? [])],
      deny: [...base.permissions.deny, ...(layer.permissions.deny ?? [])],
    };
  }
  if (layer.hooks) {
    next.hooks = {
      pre_tool: [...base.hooks.pre_tool, ...(layer.hooks.pre_tool ?? [])],
      post_tool: [...base.hooks.post_tool, ...(layer.hooks.post_tool ?? [])],
      on_stop: [...base.hooks.on_stop, ...(layer.hooks.on_stop ?? [])],
    };
  }
  return next;
}

export interface LoadOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  trustProject?: boolean;
}

export function loadConfig(opts: LoadOptions): Config {
  const userRaw = readJson(path.join(userConfigDir(), "config.json")) ?? {};
  const settingsDir = projectSettingsDir(opts.cwd);
  const projectRaw = readJson(path.join(settingsDir, "settings.json")) ?? {};
  const localRaw = readJson(path.join(settingsDir, "settings.local.json"));

  const hasProjectLayer = Object.keys(projectRaw).length > 0 || localRaw !== null;
  const fingerprint = projectFingerprint(projectRaw, localRaw);
  const trusted = !hasProjectLayer || (opts.trustProject ?? false) || isProjectTrusted(opts.cwd, fingerprint);

  let cfg = mergeLayer(DEFAULTS, userRaw, "user");
  if (hasProjectLayer) {
    const project = trusted ? projectRaw : stripExecutable(projectRaw);
    cfg = mergeLayer(cfg, project, trusted ? "project" : "project (untrusted: ignored keys)");
    if (localRaw) cfg = mergeLayer(cfg, trusted ? localRaw : stripExecutable(localRaw), "local");
  }

  const env = opts.env;
  if (env.OPENCLI_MODEL ?? env.LLMCLI_MODEL) cfg.model = env.OPENCLI_MODEL ?? env.LLMCLI_MODEL!;
  if (env.OPENCLI_URL ?? env.LLMCLI_URL) cfg.url = env.OPENCLI_URL ?? env.LLMCLI_URL!;
  const providerEnv = env.OPENCLI_PROVIDER ?? env.LLMCLI_PROVIDER;
  if (providerEnv === "openai" || providerEnv === "anthropic" || providerEnv === "azure") cfg.provider = providerEnv;
  const keyFromEnv =
    env.OPENCLI_API_KEY ??
    env.LLMCLI_API_KEY ??
    (cfg.provider === "anthropic" ? env.ANTHROPIC_API_KEY : cfg.provider === "azure" ? env.AZURE_OPENAI_API_KEY : env.OPENAI_API_KEY);
  if (keyFromEnv) cfg.apiKey = keyFromEnv;
  if (cfg.provider === "anthropic" && cfg.url === DEFAULTS.url) cfg.url = "https://api.anthropic.com/v1";
  if (cfg.provider === "azure" && cfg.url === DEFAULTS.url) cfg.url = "https://YOUR-RESOURCE.openai.azure.com/openai/v1";

  return { ...cfg, trusted, projectTrustNeeded: hasProjectLayer && !trusted, sources: cfg.sources };
}

function stripExecutable(raw: RawConfig): RawConfig {
  const copy: RawConfig = { ...raw };
  delete copy.provider;
  delete copy.url;
  delete copy.apiKey;
  delete copy.modelProfiles;
  delete copy.prices;
  delete copy.mcpServers;
  delete copy.hooks;
  delete copy.verifyCommand;
  delete copy.permissions;
  delete copy.sandbox;
  return copy;
}

export function projectFingerprintFor(cwd: string): string {
  const settingsDir = projectSettingsDir(cwd);
  const projectRaw = readJson(path.join(settingsDir, "settings.json")) ?? {};
  const localRaw = readJson(path.join(settingsDir, "settings.local.json"));
  return projectFingerprint(projectRaw, localRaw);
}

export function projectSettingsDir(cwd: string): string {
  const opencli = path.join(cwd, ".opencli");
  if (fs.existsSync(opencli) || !fs.existsSync(path.join(cwd, ".llmcli"))) return opencli;
  return path.join(cwd, ".llmcli");
}
