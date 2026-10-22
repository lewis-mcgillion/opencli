import { checkUrl } from "../net-guard";
import type { ToolDef } from "../runtime";

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2_000_000;

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

async function fetchChecked(start: string, allowPrivate: boolean): Promise<string> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowPrivate) {
      const check = await checkUrl(url);
      if (!check.ok) throw new Error(check.reason);
    } else if (!/^https?:\/\//i.test(url)) {
      throw new Error("only http and https URLs are supported");
    }
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const type = res.headers.get("content-type") ?? "";
    if (type && !/^(text\/|application\/(json|xml|xhtml)|\+json|\+xml)/i.test(type)) {
      return `[binary content: ${type}]`;
    }
    const text = (await res.text()).slice(0, MAX_BODY_BYTES);
    return /<html/i.test(text) ? htmlToText(text) : text;
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
