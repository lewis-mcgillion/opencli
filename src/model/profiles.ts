import type { Config, Prices } from "../config";

export type ProviderName = "openai" | "anthropic" | "azure";

export interface ModelProfile {
  id: string;
  label: string;
  model?: string;
  source?: "builtin" | "user" | "project" | "local";
  provider: ProviderName;
  url: string;
  apiKeyEnv: string;
  contextWindow: number;
  maxOutputTokens: number;
  toolCalls: boolean;
  streaming: boolean;
  images: boolean;
  web: boolean;
  prices?: Prices;
  quirks: string[];
}

export const BUILTIN_MODEL_PROFILES: ModelProfile[] = [
  {
    id: "local-openai",
    label: "OpenAI-compatible local endpoint",
    provider: "openai",
    url: "http://localhost:11434/v1",
    apiKeyEnv: "OPENCLI_API_KEY or LLMCLI_API_KEY",
    contextWindow: 32768,
    maxOutputTokens: 8192,
    toolCalls: true,
    streaming: true,
    images: false,
    web: false,
    quirks: ["Works with Ollama, LM Studio, llama.cpp and other Chat Completions-compatible local servers when tool calls are implemented."],
  },
  {
    id: "openai",
    label: "OpenAI API",
    provider: "openai",
    url: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY or OPENCLI_API_KEY",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    toolCalls: true,
    streaming: true,
    images: false,
    web: false,
    quirks: ["Model capabilities vary; set model/context/prices in config for exact accounting."],
  },
  {
    id: "azure-openai",
    label: "Azure OpenAI / Foundry OpenAI",
    provider: "azure",
    url: "https://YOUR-RESOURCE.openai.azure.com/openai/v1",
    apiKeyEnv: "AZURE_OPENAI_API_KEY or OPENCLI_API_KEY",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    toolCalls: true,
    streaming: true,
    images: false,
    web: false,
    quirks: ["Use the deployment name as the model value.", "Some reasoning deployments may require provider-specific settings beyond Chat Completions."],
  },
  {
    id: "anthropic",
    label: "Anthropic API",
    provider: "anthropic",
    url: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY or OPENCLI_API_KEY",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    toolCalls: true,
    streaming: false,
    images: false,
    web: false,
    quirks: ["The current adapter returns a full response rather than streaming text chunks."],
  },
];

export type CustomModelProfile = Partial<Omit<ModelProfile, "id" | "source">> & { id?: string };

/** Config layers merge each profile by id; omitted fields retain the earlier value. */
export function mergeModelProfiles(
  previous: Record<string, ModelProfile>,
  definitions: Record<string, CustomModelProfile>,
  source: "user" | "project" | "local",
): Record<string, ModelProfile> {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) {
    throw new Error("modelProfiles must be an object keyed by profile id");
  }
  const merged = { ...previous };
  for (const [id, definition] of Object.entries(definitions)) {
    const fail = (field: string): never => { throw new Error(`invalid model profile ${id}: ${field}`); };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) fail("id");
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) fail("expected an object");
    if (definition.id !== undefined && definition.id !== id) fail("id must match its config key");
    const old = Object.hasOwn(previous, id) ? previous[id] : BUILTIN_MODEL_PROFILES.find((p) => p.id === id);
    const provider = definition.provider ?? old?.provider ?? "openai";
    if (!["openai", "anthropic", "azure"].includes(provider)) fail("provider must be openai, anthropic or azure");
    const defaults = BUILTIN_MODEL_PROFILES.find((p) => p.id === (provider === "azure" ? "azure-openai" : provider === "anthropic" ? "anthropic" : "local-openai"))!;
    const profile: ModelProfile = { ...defaults, ...old, provider, id, label: old?.label ?? id, source };
    for (const field of ["label", "url", "apiKeyEnv", "model"] as const) {
      const value = definition[field];
      if (value !== undefined) {
        if (typeof value !== "string" || !value.trim()) fail(field);
        profile[field] = value;
      }
    }
    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      const value = definition[field];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value <= 0) fail(`${field} must be a positive integer`);
        profile[field] = value;
      }
    }
    for (const field of ["toolCalls", "streaming", "images", "web"] as const) {
      if (definition[field] !== undefined) {
        if (typeof definition[field] !== "boolean") fail(field);
        profile[field] = definition[field]!;
      }
    }
    if (definition.quirks !== undefined) {
      if (!Array.isArray(definition.quirks) || definition.quirks.some((q) => typeof q !== "string")) fail("quirks");
      profile.quirks = [...definition.quirks];
    }
    if (definition.prices !== undefined) {
      const prices = definition.prices;
      if (!prices || ![prices.inputPerMTok, prices.outputPerMTok].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) fail("prices");
      profile.prices = { inputPerMTok: prices.inputPerMTok, outputPerMTok: prices.outputPerMTok };
    }
    if (!profile.apiKeyEnv.split(/\s+or\s+/).every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) fail("apiKeyEnv must name an environment variable (or alternatives separated by ' or ')");
    try {
      if (!["http:", "https:"].includes(new URL(profile.url).protocol)) fail("url must use http or https");
    } catch { fail("url must use http or https"); }
    Object.defineProperty(merged, id, { value: profile, enumerable: true, configurable: true, writable: true });
  }
  return merged;
}

export function listModelProfiles(custom: Record<string, ModelProfile> = {}): ModelProfile[] {
  const profiles = new Map<string, ModelProfile>(BUILTIN_MODEL_PROFILES.map((p) => [p.id, { ...p, source: "builtin" }]));
  for (const profile of Object.values(custom)) profiles.set(profile.id, profile);
  return [...profiles.values()];
}

export function findModelProfile(id: string, custom: Record<string, ModelProfile> = {}): ModelProfile | undefined {
  return listModelProfiles(custom).find((profile) => profile.id === id);
}

export function profileToConfig(profile: ModelProfile): Partial<Config> {
  const cfg: Partial<Config> = {
    provider: profile.provider,
    url: profile.url,
    contextWindow: profile.contextWindow,
    maxOutputTokens: profile.maxOutputTokens,
  };
  if (profile.model) cfg.model = profile.model;
  if (profile.prices) cfg.prices = { [profile.model ?? profile.id]: profile.prices };
  return cfg;
}

export function resolveProfileConfig(base: Config, profile: ModelProfile, env: NodeJS.ProcessEnv): Config {
  const model = env.OPENCLI_MODEL || env.LLMCLI_MODEL || profile.model || base.model;
  const providerKey = profile.provider === "azure" ? env.AZURE_OPENAI_API_KEY
    : profile.provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
  const profileKey = profile.apiKeyEnv.split(/\s+or\s+/).map((name) => env[name]).find(Boolean);
  return {
    ...base,
    ...profileToConfig(profile),
    model,
    url: env.OPENCLI_URL || env.LLMCLI_URL || profile.url,
    apiKey: env.OPENCLI_API_KEY || env.LLMCLI_API_KEY || profileKey || providerKey || (base.provider === profile.provider ? base.apiKey : undefined),
    prices: { ...base.prices, ...(profile.prices ? { [model]: profile.prices } : {}) },
    sources: [...base.sources, `profile:${profile.id}`],
  };
}

export function renderProfiles(custom: Record<string, ModelProfile> = {}): string {
  const header = "id             source    provider   stream tools context  default url";
  const rows = listModelProfiles(custom).map((profile) => {
    const id = profile.id.padEnd(14);
    const source = (profile.source ?? "custom").padEnd(9);
    const provider = profile.provider.padEnd(9);
    const stream = (profile.streaming ? "yes" : "no").padEnd(6);
    const tools = (profile.toolCalls ? "yes" : "no").padEnd(5);
    const context = String(profile.contextWindow).padEnd(8);
    return `${id} ${source} ${provider} ${stream} ${tools} ${context} ${profile.url}`;
  });
  return [header, ...rows].join("\n");
}
