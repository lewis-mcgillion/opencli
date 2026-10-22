import type { Config } from "../config";
import type { ModelProvider } from "../types";
import { createAnthropicProvider } from "./anthropic";
import { createOpenAIProvider } from "./openai";

export function createProvider(cfg: Config): ModelProvider {
  if (cfg.provider === "anthropic") {
    return createAnthropicProvider({ url: cfg.url, apiKey: cfg.apiKey, maxTokens: cfg.maxOutputTokens });
  }
  return createOpenAIProvider({ url: cfg.url, apiKey: cfg.apiKey });
}
