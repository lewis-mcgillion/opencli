export interface SseEvent {
  event: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  let data: string[] = [];
  for await (const chunk of body as any) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
  if (data.length) yield { event, data: data.join("\n") };
}
