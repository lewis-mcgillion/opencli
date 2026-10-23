import { describe, expect, test } from "bun:test";
import { createOpenAIProvider } from "../src/model/openai";
import { recoverTextToolCalls } from "../src/model/fallback";
import { findModelProfile, listModelProfiles, mergeModelProfiles, renderProfiles, resolveProfileConfig } from "../src/model/profiles";
import { DEFAULTS, loadConfig } from "../src/config";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compactHistory, estimateTokens, needsCompaction, elideOldToolOutputs } from "../src/context";
import { startFakeModel } from "./helpers/fake-model";
import type { ToolSpec, Message, ModelProvider } from "../src/types";

const readSpec: ToolSpec = {
  name: "read_file",
  description: "read",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

describe("openai provider", () => {
  test("streams text, reports usage and sends tools", async () => {
    const fake = startFakeModel([{ text: "hello world", usage: { prompt: 7, completion: 3 } }]);
    try {
      const provider = createOpenAIProvider({ url: fake.url, apiKey: "k" });
      const deltas: string[] = [];
      const res = await provider.chat({
        model: "m",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
        tools: [readSpec],
        onText: (t) => deltas.push(t),
      });
      expect(deltas.join("")).toBe("hello world");
      expect(res.message.content).toBe("hello world");
      expect(res.usage).toEqual({ input: 7, output: 3 });
      expect(fake.requests[0].stream).toBe(true);
      expect(fake.requests[0].tools[0].function.name).toBe("read_file");
      expect(fake.requests[0].tool_choice).toBe("auto");
    } finally {
      fake.stop();
    }
  });

  test("assembles streamed tool calls", async () => {
    const fake = startFakeModel([{ toolCalls: [{ name: "read_file", arguments: { path: "a.txt" } }] }]);
    try {
      const res = await createOpenAIProvider({ url: fake.url }).chat({ model: "m", messages: [], tools: [readSpec] });
      expect(res.message.tool_calls?.length).toBe(1);
      expect(res.message.tool_calls?.[0].function.name).toBe("read_file");
      expect(JSON.parse(res.message.tool_calls![0].function.arguments)).toEqual({ path: "a.txt" });
    } finally {
      fake.stop();
    }
  });

  test("retries a 503 and reports the retry", async () => {
    const fake = startFakeModel([{ status: 503 }, { text: "ok" }]);
    try {
      const retries: number[] = [];
      const res = await createOpenAIProvider({ url: fake.url }).chat({
        model: "m",
        messages: [],
        tools: [],
        onRetry: (attempt) => retries.push(attempt),
      });
      expect(res.message.content).toBe("ok");
      expect(retries).toEqual([2]);
      expect(fake.requests.length).toBe(2);
    } finally {
      fake.stop();
    }
  });

  test("backs off and retries 429 rate limits using retry headers", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      async fetch() {
        calls++;
        if (calls === 1) {
          return new Response('{"error":"rate limited"}', {
            status: 429,
            headers: { "retry-after-ms": "0" },
          });
        }
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      const retries: string[] = [];
      const res = await createOpenAIProvider({ url: `http://localhost:${server.port}/v1` }).chat({
        model: "m",
        messages: [],
        tools: [],
        onRetry: (_attempt, reason) => retries.push(reason),
      });
      expect(res.message.content).toBe("ok");
      expect(calls).toBe(2);
      expect(retries[0]).toContain("HTTP 429");
      expect(retries[0]).toContain("backing off 0ms");
    } finally {
      server.stop(true);
    }
  });

  test("does not retry a 400", async () => {
    const fake = startFakeModel([{ status: 400 }]);
    try {
      await expect(createOpenAIProvider({ url: fake.url }).chat({ model: "m", messages: [], tools: [] })).rejects.toThrow("API 400");
      expect(fake.requests.length).toBe(1);
    } finally {
      fake.stop();
    }
  });

  test("uses api-key instead of Authorization for Azure-compatible endpoints", async () => {
    const seen: Headers[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push(req.headers);
        return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    try {
      await createOpenAIProvider({ url: `http://localhost:${server.port}/v1`, apiKey: "az-key", azure: true }).chat({ model: "m", messages: [], tools: [] });
      expect(seen[0].get("api-key")).toBe("az-key");
      expect(seen[0].get("authorization")).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});

describe("model profiles", () => {
  test("include Azure and local OpenAI-compatible profiles", () => {
    const out = renderProfiles();
    expect(out).toContain("azure-openai");
    expect(out).toContain("local-openai");
  });

  test("custom profiles inherit provider defaults and override built-ins without duplicates", () => {
    const custom = mergeModelProfiles({}, {
      foundry: { provider: "azure", model: "deployment", url: "https://resource.openai.azure.com/openai/v1", apiKeyEnv: "FOUNDRY_KEY", contextWindow: 64000, maxOutputTokens: 4096 },
      openai: { contextWindow: 256000, streaming: false },
    }, "user");
    const azure = findModelProfile("foundry", custom)!;
    expect(azure.provider).toBe("azure");
    expect(azure.toolCalls).toBe(true);
    expect(azure.apiKeyEnv).toBe("FOUNDRY_KEY");
    expect(azure.source).toBe("user");
    expect(listModelProfiles(custom).filter((p) => p.id === "openai")).toHaveLength(1);
    expect(findModelProfile("openai", custom)?.contextWindow).toBe(256000);
    expect(findModelProfile("openai", custom)?.streaming).toBe(false);
    expect(findModelProfile("anthropic", custom)?.source).toBe("builtin");
    expect(renderProfiles(custom)).toContain("foundry");
    expect(renderProfiles(custom)).toContain("user");
    expect(findModelProfile("openai")?.contextWindow).toBe(128000);
  });

  test("loads and merges user, project and local profiles from persisted legacy settings", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "opencli-profiles-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "opencli-profiles-project-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      fs.mkdirSync(path.join(home, ".llmcli"));
      fs.mkdirSync(path.join(project, ".llmcli"));
      fs.writeFileSync(path.join(home, ".llmcli", "config.json"), JSON.stringify({ modelProfiles: {
        foundry: { provider: "azure", model: "deployment", url: "https://resource.openai.azure.com/openai/v1", apiKeyEnv: "FOUNDRY_KEY", contextWindow: 64000 },
        personal: { url: "http://localhost:9000/v1" },
      } }));
      fs.writeFileSync(path.join(project, ".llmcli", "settings.json"), JSON.stringify({ modelProfiles: { foundry: { contextWindow: 96000, maxOutputTokens: 2048 } } }));
      fs.writeFileSync(path.join(project, ".llmcli", "settings.local.json"), JSON.stringify({ modelProfiles: { foundry: { model: "local-deployment" } } }));
      const cfg = loadConfig({ cwd: project, env: {} });
      expect(cfg.modelProfiles.foundry).toMatchObject({ provider: "azure", model: "local-deployment", apiKeyEnv: "FOUNDRY_KEY", contextWindow: 96000, maxOutputTokens: 2048, source: "local" });
      expect(cfg.modelProfiles.personal.source).toBe("user");
      expect(cfg.projectTrustNeeded).toBe(true);
      expect(cfg.model).toBe(DEFAULTS.model);
      expect(DEFAULTS.modelProfiles).toEqual({});
      expect(resolveProfileConfig(cfg, cfg.modelProfiles.foundry, { FOUNDRY_KEY: "custom-secret" }).apiKey).toBe("custom-secret");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  test("profile resolution applies metadata, keeps prices and resolves the selected provider key", () => {
    const profiles = mergeModelProfiles({}, { foundry: { provider: "azure", model: "deployment", apiKeyEnv: "CUSTOM_KEY", contextWindow: 64000, maxOutputTokens: 2048, prices: { inputPerMTok: 1, outputPerMTok: 2 } } }, "project");
    const base = { ...DEFAULTS, apiKey: "wrong-provider-key", prices: { other: { inputPerMTok: 3, outputPerMTok: 4 } } };
    const cfg = resolveProfileConfig(base, profiles.foundry, { CUSTOM_KEY: "custom-secret", OPENAI_API_KEY: "openai-secret", LLMCLI_URL: "" });
    expect(cfg).toMatchObject({ provider: "azure", model: "deployment", apiKey: "custom-secret", contextWindow: 64000, maxOutputTokens: 2048 });
    expect(cfg.url).toContain("openai.azure.com");
    expect(cfg.prices.deployment).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
    expect(cfg.prices.other).toEqual(base.prices.other);
    expect(resolveProfileConfig(base, profiles.foundry, {}).apiKey).toBeUndefined();
    const envOverride = resolveProfileConfig(base, profiles.foundry, { OPENCLI_MODEL: "env-model", LLMCLI_MODEL: "legacy-model", OPENCLI_URL: "https://override/v1", OPENCLI_API_KEY: "generic", CUSTOM_KEY: "custom" });
    expect(envOverride).toMatchObject({ model: "env-model", url: "https://override/v1", apiKey: "generic" });
    expect(envOverride.prices["env-model"]).toEqual(cfg.prices.deployment);
    expect(resolveProfileConfig(base, profiles.foundry, { LLMCLI_MODEL: "legacy", LLMCLI_API_KEY: "legacy-key" })).toMatchObject({ model: "legacy", apiKey: "legacy-key" });
    expect(resolveProfileConfig(base, findModelProfile("azure-openai")!, { AZURE_OPENAI_API_KEY: "azure-key", OPENAI_API_KEY: "wrong" }).apiKey).toBe("azure-key");
    expect(resolveProfileConfig(base, findModelProfile("anthropic")!, { ANTHROPIC_API_KEY: "anthropic-key" }).apiKey).toBe("anthropic-key");
  });

  test("rejects malformed profiles with actionable errors", () => {
    for (const definition of [{ provider: "invalid" }, { contextWindow: -1 }, { maxOutputTokens: 0 }, { streaming: "yes" }, { url: "file:///tmp/model" }, { apiKeyEnv: "BAD KEY" }, { prices: { inputPerMTok: -1, outputPerMTok: 0 } }, { quirks: [2] }, { id: "other" }]) {
      expect(() => mergeModelProfiles({}, { bad: definition as any }, "user")).toThrow("invalid model profile bad");
    }
    expect(() => mergeModelProfiles({}, [] as any, "user")).toThrow("modelProfiles must be an object");
  });

});

describe("text tool-call fallback", () => {
  test("recovers a fenced JSON call for a known tool", () => {
    const text = 'I will read it.\n```json\n{"name":"read_file","arguments":{"path":"a.txt"}}\n```';
    const calls = recoverTextToolCalls(text, [readSpec]);
    expect(calls?.[0].function.name).toBe("read_file");
    expect(JSON.parse(calls![0].function.arguments)).toEqual({ path: "a.txt" });
  });

  test("recovers a <tool_call> tag with string arguments", () => {
    const text = '<tool_call>{"name":"read_file","parameters":"{\\"path\\":\\"b\\"}"}</tool_call>';
    expect(recoverTextToolCalls(text, [readSpec])?.length).toBe(1);
  });

  test("ignores unknown tools, missing required args and prose", () => {
    expect(recoverTextToolCalls('{"name":"delete_all","arguments":{}}', [readSpec])).toBeNull();
    expect(recoverTextToolCalls('{"name":"read_file","arguments":{}}', [readSpec])).toBeNull();
    expect(recoverTextToolCalls("Just reading the file now.", [readSpec])).toBeNull();
  });
});

describe("context management", () => {
  const big = "x".repeat(4000);
  const history: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", content: big },
    ...Array.from({ length: 8 }, (_, i) => ({ role: "user" as const, content: `m${i}` })),
  ];

  test("estimates tokens and flags compaction near the window", () => {
    expect(estimateTokens(history)).toBeGreaterThan(1000);
    expect(needsCompaction(history, 1000)).toBe(true);
    expect(needsCompaction(history, 1_000_000)).toBe(false);
  });

  test("elides old large tool outputs but keeps recent ones", () => {
    const copy = JSON.parse(JSON.stringify(history)) as Message[];
    elideOldToolOutputs(copy);
    expect(copy[3].content).toContain("[older output elided]");
    expect(copy[3].content!.length).toBeLessThan(400);
  });

  test("compaction keeps the system prompt and recent turns, replacing older ones with a summary", async () => {
    const seen: Message[][] = [];
    const provider: ModelProvider = {
      name: "stub",
      async chat(req) {
        seen.push(req.messages);
        return { message: { role: "assistant", content: "the summary" } };
      },
    };
    const copy = JSON.parse(JSON.stringify(history)) as Message[];
    const result = await compactHistory(provider, "m", copy);
    expect(result).not.toBeNull();
    expect(copy[0].content).toBe("sys");
    expect(copy[1].content).toBe("Summary of earlier conversation: the summary");
    expect(copy[copy.length - 1].content).toBe("m7");
    expect(seen[0][seen[0].length - 1].role).toBe("user");
  });
});
