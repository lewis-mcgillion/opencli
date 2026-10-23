import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { checkUrl } from "../net-guard";
import type { ToolDef } from "../runtime";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface FetchResponse {
  status: number;
  headers: Headers;
  text: string;
}

function hostHeader(url: URL): string {
  const needsBrackets = url.hostname.includes(":") && !url.hostname.startsWith("[");
  const host = needsBrackets ? `[${url.hostname}]` : url.hostname;
  return url.port ? `${host}:${url.port}` : host;
}

function requestChecked(url: URL, address?: string): Promise<FetchResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const headers: Record<string, string> = {
      Accept: "text/*, application/json, application/xml, application/xhtml+xml, */*;q=0.1",
      "Accept-Encoding": "identity",
      Host: hostHeader(url),
      "User-Agent": "opencli-web-fetch",
    };
    const req = transport.request({
      method: "GET",
      protocol: url.protocol,
      hostname: address ?? url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers,
      servername: url.protocol === "https:" && address && isIP(url.hostname) === 0 ? url.hostname : undefined,
      timeout: FETCH_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let clipped = false;

      res.on("data", (chunk: Buffer | string) => {
        if (clipped) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = MAX_BODY_BYTES - total;
        if (buf.length > remaining) {
          if (remaining > 0) chunks.push(buf.subarray(0, remaining));
          total = MAX_BODY_BYTES;
          clipped = true;
          res.destroy();
          return;
        }
        chunks.push(buf);
        total += buf.length;
      });
      res.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) headers.set(name, value.join(", "));
          else if (value !== undefined) headers.set(name, String(value));
        }
        resolve({ status: res.statusCode ?? 0, headers, text: Buffer.concat(chunks, total).toString("utf8") });
      });
      res.on("close", () => {
        if (!clipped) return;
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) headers.set(name, value.join(", "));
          else if (value !== undefined) headers.set(name, String(value));
        }
        resolve({ status: res.statusCode ?? 0, headers, text: Buffer.concat(chunks, total).toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`timeout fetching ${url.toString()}`)));
    req.on("error", reject);
    req.end();
  });
}

export async function fetchChecked(start: string, allowPrivate: boolean): Promise<string> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    let address: string | undefined;
    if (!allowPrivate) {
      const check = await checkUrl(url);
      if (!check.ok) throw new Error(check.reason);
      parsed = check.url;
      address = check.addresses[0];
    } else if (!/^https?:\/\//i.test(url)) {
      throw new Error("only http and https URLs are supported");
    } else {
      parsed = new URL(url);
    }
    const res = await requestChecked(parsed, address);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${url}`);
    const type = res.headers.get("content-type") ?? "";
    if (type && !/^(text\/|application\/(json|xml|xhtml)|\+json|\+xml)/i.test(type)) {
      return `[binary content: ${type}]`;
    }
    return /<html/i.test(res.text) ? htmlToText(res.text) : res.text;
  }
  throw new Error(`too many redirects starting at ${start}`);
}

export const webTools: ToolDef[] = [
  {
    name: "web_fetch",
    description: "Fetch a http or https URL (GET). Strips HTML tags. Returns clipped text. Private and local addresses are blocked unless allowed by a rule.",
    kind: "network",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL to fetch" } },
      required: ["url"],
    },
    subject: (args) => String(args.url ?? ""),
    preflight: async (args) => {
      const check = await checkUrl(String(args.url ?? ""));
      return check.ok ? null : { message: check.reason, denied: true };
    },
    run: async (args, _rt, call) => fetchChecked(String(args.url ?? ""), call.explicitAllow),
  },
];
