export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ name: string; arguments: object | string }>;
  status?: number;
  usage?: { prompt: number; completion: number };
}

export interface FakeModel {
  url: string;
  requests: any[];
  stop(): void;
}

function sse(events: unknown[]): string {
  return events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");
}

export function startFakeModel(script: ScriptStep[]): FakeModel {
  const requests: any[] = [];
  let cursor = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      requests.push(body);
      const step = script[Math.min(cursor, script.length - 1)];
      cursor++;
      if (step.status) {
        return new Response(`{"error":"status ${step.status}"}`, { status: step.status });
      }
      const events: unknown[] = [];
      if (step.text) events.push({ choices: [{ delta: { content: step.text } }] });
      (step.toolCalls ?? []).forEach((tc, i) => {
        events.push({
          choices: [{
            delta: {
              tool_calls: [{
                index: i,
                id: `call_${cursor}_${i}`,
                function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments) },
              }],
            },
          }],
        });
      });
      events.push({ choices: [{ delta: {}, finish_reason: step.toolCalls?.length ? "tool_calls" : "stop" }] });
      events.push({
        choices: [],
        usage: { prompt_tokens: step.usage?.prompt ?? 10, completion_tokens: step.usage?.completion ?? 5 },
      });
      events.push("[DONE]");
      return new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
}
