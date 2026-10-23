import * as dns from "node:dns/promises";
import { isIP } from "node:net";

const PRIVATE_V4: Array<[number, number]> = [
  [ip4("0.0.0.0"), 8], [ip4("10.0.0.0"), 8], [ip4("100.64.0.0"), 10], [ip4("127.0.0.0"), 8],
  [ip4("169.254.0.0"), 16], [ip4("172.16.0.0"), 12], [ip4("192.168.0.0"), 16],
  [ip4("198.18.0.0"), 15], [ip4("224.0.0.0"), 4], [ip4("240.0.0.0"), 4],
];

function ip4(text: string): number {
  return text.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateV4(addr: string): boolean {
  const n = ip4(addr);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function isPrivateV6(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "::" || a === "::1") return true;
  if (a.startsWith("::ffff:")) {
    const v4 = a.slice(7);
    return isIP(v4) === 4 ? isPrivateV4(v4) : true;
  }
  return /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
}

export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return isPrivateV4(addr);
  if (family === 6) return isPrivateV6(addr);
  return true;
}

export type UrlCheck = { ok: true; url: URL; host: string; addresses: string[] } | { ok: false; reason: string };

type ResolveAddresses = (hostname: string) => Promise<readonly string[]>;

const resolveAddresses: ResolveAddresses = async (hostname) => (await dns.lookup(hostname, { all: true })).map((r) => r.address);

export async function checkUrl(raw: string, resolve: ResolveAddresses = resolveAddresses): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https URLs are supported" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : await resolve(host).catch(() => []);
  if (addresses.length === 0) return { ok: false, reason: `could not resolve ${host}` };
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) return { ok: false, reason: `${host} resolves to a private or local address (${blocked})` };
  return { ok: true, url, host, addresses: [...addresses] };
}

export function isPrivateUrlTarget(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
    return isIP(host) !== 0 ? isPrivateAddress(host) : host === "localhost" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}
