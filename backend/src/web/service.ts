import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 2_000_000;

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 ("this network" / localhost on Linux)
    a === 10 || // 10.0.0.0/8
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT / Tailscale
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // multicast & reserved
  );
}

function extractMappedIpv4(lowerIpv6: string): string | undefined {
  const withoutZone = lowerIpv6.split("%")[0] ?? lowerIpv6;
  if (!withoutZone.startsWith("::ffff:")) return undefined;
  const tail = withoutZone.slice(7);
  if (isIP(tail) === 4) return tail;
  const parts = tail.split(":");
  if (parts.length === 2 && /^[0-9a-f]{1,4}$/.test(parts[0]!) && /^[0-9a-f]{1,4}$/.test(parts[1]!)) {
    const hi = parseInt(parts[0]!, 16);
    const lo = parseInt(parts[1]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return undefined;
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = stripBrackets(rawIp).split("%")[0]!.toLowerCase();
  const family = isIP(ip);
  if (family === 4) return isPrivateOrReservedIpv4(ip);
  if (family === 6) {
    if (ip === "::" || ip === "::1") return true;
    const mappedV4 = extractMappedIpv4(ip);
    if (mappedV4) return isPrivateOrReservedIpv4(mappedV4);
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
    if (ip.startsWith("ff")) return true; // ff00::/8 multicast
    if (ip.startsWith("2001:db8:")) return true; // documentation
    return false;
  }
  return true;
}

function assertSafeUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing embedded credentials are not allowed.");
  }
  const hostname = stripBrackets(url.hostname).toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Local network hosts are not allowed.");
  }

  if (isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new Error("Private or link-local addresses are not allowed.");
  }

  return url;
}

export class WebFetchService {
  async fetchText(input: string, timeoutMs = 15000): Promise<{
    url: string;
    status: number;
    contentType: string;
    text: string;
  }> {
    const url = assertSafeUrl(input);
    const host = stripBrackets(url.hostname);
    const boundedTimeout = Number.isFinite(timeoutMs)
      ? Math.min(Math.max(Math.trunc(timeoutMs), 1000), 30000)
      : 15000;

    let resolved: { address: string; family: number };
    const literalFamily = isIP(host);
    if (literalFamily) {
      if (isPrivateOrReservedIp(host)) {
        throw new Error("Private or link-local addresses are not allowed.");
      }
      resolved = { address: host, family: literalFamily };
    } else {
      const addresses = await lookup(host, { all: true });
      if (addresses.length === 0) {
        throw new Error("Unable to resolve target hostname.");
      }
      for (const entry of addresses) {
        if (isPrivateOrReservedIp(entry.address)) {
          throw new Error("Resolved host points to a private or reserved address.");
        }
      }
      const first = addresses[0]!;
      resolved = { address: first.address, family: first.family };
    }

    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;

    return new Promise((resolvePromise, reject) => {
      const req = transport(
        url,
        {
          method: "GET",
          headers: { "User-Agent": "Friday-Agent/0.1" },
          lookup: (_hostname, _options, callback) => {
            callback(null, resolved.address, resolved.family);
          }
        },
        res => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            reject(new Error("Redirect responses are not allowed by the web fetch tool."));
            return;
          }

          const contentLength = Number(res.headers["content-length"]);
          if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error("Web response exceeds the 2 MB limit."));
            return;
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on("data", (chunk: Buffer) => {
            totalBytes += chunk.byteLength;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              res.destroy();
              reject(new Error("Web response exceeds the 2 MB limit."));
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            const contentTypeHeader = res.headers["content-type"];
            const contentType = Array.isArray(contentTypeHeader)
              ? contentTypeHeader[0] ?? "application/octet-stream"
              : contentTypeHeader ?? "application/octet-stream";

            resolvePromise({
              url: url.toString(),
              status,
              contentType,
              text: Buffer.concat(chunks).toString("utf8")
            });
          });

          res.on("error", reject);
        }
      );

      req.setTimeout(boundedTimeout, () => {
        req.destroy(new Error("Web fetch request timed out."));
      });
      req.on("error", reject);
      req.end();
    });
  }
}
