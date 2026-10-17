import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { BlockList, isIP } from "node:net";
import sharp from "sharp";
import { MAX_IMAGE_BYTES, type AllowedImageType } from "../../integrations/object-storage";
import { IMAGE_SIZES } from "./image-view";

/**
 * Pictures fetched from addresses given in a product import sheet.
 *
 * The API downloads them itself, so an address must never reach anything but
 * the public internet: the host's every IP address is checked when the
 * connection is made (which also covers DNS answers that change between a
 * check and the request), every redirect is checked again, only the standard
 * web ports are allowed, and the download is capped in size and time.
 */

/** A downloaded file larger than this is refused; one between MAX_IMAGE_BYTES and this is shrunk. */
export const MAX_REMOTE_IMAGE_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;
const PIXEL_LIMIT = 60_000_000;
/** The longest side of a picture that had to be shrunk to fit MAX_IMAGE_BYTES. */
const SHRINK_TO = 2400;

export class RemoteImageError extends Error {}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** IPv4 inside an IPv4-mapped / -compatible IPv6 address ("::ffff:10.0.0.1", "::ffff:a00:1"), else null. */
function embeddedIpv4(address: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const [hi, lo] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** Whether an IP address is on the public internet (not loopback, private, link-local, reserved or multicast). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    return v4 ? isPublicAddress(v4) : !blocked.check(address, "ipv6");
  }
  return false;
}

/** Share links of common file services, turned into the address of the file itself. */
export function directImageUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  if (url.hostname === "drive.google.com") {
    const id = /\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("id");
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  }
  if (/(^|\.)dropbox\.com$/.test(url.hostname) && url.searchParams.get("dl") === "0") {
    url.searchParams.set("dl", "1");
    return url.toString();
  }
  return url.toString();
}

const guardedLookup: NonNullable<http.RequestOptions["lookup"]> = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 4);
    const list = addresses as unknown as dns.LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} is not on the public internet`), { code: "EBLOCKED" }), "", 4);
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** Checks what can be checked before connecting: scheme, port and a literal IP address. */
function checkAddress(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new RemoteImageError("Only http:// and https:// addresses can be used");
  if (url.username || url.password) throw new RemoteImageError("Addresses with a user name or password cannot be used");
  if (url.port && url.port !== "80" && url.port !== "443") throw new RemoteImageError("Only addresses on the standard web ports can be used");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new RemoteImageError("The address points into a private network");
  if (!isIP(host) && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))) {
    throw new RemoteImageError("The address points into a private network");
  }
}

type Answer = { status: number; location?: string; contentType?: string; body?: Buffer };

function getOnce(url: URL, deadline: number): Promise<Answer> {
  return new Promise<Answer>((settleOk, settleErr) => {
    // The socket timeout below only notices silence; this also stops a server that sends very slowly.
    const timer = setTimeout(() => req.destroy(new RemoteImageError("The download took too long")), Math.max(1, deadline - Date.now()));
    const resolve = (a: Answer) => (clearTimeout(timer), settleOk(a));
    const reject = (e: unknown) => (clearTimeout(timer), settleErr(e));
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { lookup: guardedLookup, headers: { "User-Agent": "TrendzImageImport/1.0", Accept: "image/*" }, timeout: Math.max(1, deadline - Date.now()) }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, location: res.headers.location });
      }
      if (status !== 200) {
        res.resume();
        return resolve({ status });
      }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > MAX_REMOTE_IMAGE_BYTES) {
        req.destroy();
        return reject(new RemoteImageError(`The file is larger than ${MAX_REMOTE_IMAGE_BYTES / 1024 / 1024} MB`));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REMOTE_IMAGE_BYTES) {
          req.destroy();
          reject(new RemoteImageError(`The file is larger than ${MAX_REMOTE_IMAGE_BYTES / 1024 / 1024} MB`));
        } else chunks.push(chunk);
      });
      res.on("end", () => resolve({ status, contentType: res.headers["content-type"], body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new RemoteImageError("The download took too long")));
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err instanceof RemoteImageError) return reject(err);
      if (err.code === "EBLOCKED") return reject(new RemoteImageError("The address points into a private network"));
      if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return reject(new RemoteImageError(`The site ${url.hostname} could not be found`));
      reject(new RemoteImageError(`The download failed (${err.code ?? err.message})`));
    });
  });
}

/** Downloads a picture from a public address, following a few redirects. */
export async function downloadImage(raw: string): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(directImageUrl(raw));
  } catch {
    throw new RemoteImageError("This is not a valid web address");
  }
  const deadline = Date.now() + TIMEOUT_MS;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkAddress(url);
    const res = await getOnce(url, deadline);
    if (res.location) {
      url = new URL(res.location, url);
      continue;
    }
    if (res.status !== 200 || !res.body) throw new RemoteImageError(`The site answered with status ${res.status}`);
    if (res.contentType?.startsWith("text/html")) throw new RemoteImageError("The address opens a web page, not a picture. Use the address of the image itself");
    return res.body;
  }
  throw new RemoteImageError("Too many redirects");
}

const STORED_AS: Record<string, AllowedImageType> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" };

/**
 * Checks that a downloaded file is a picture and makes it fit the upload limit:
 * a JPEG, PNG, WebP or AVIF within MAX_IMAGE_BYTES is kept as it is; anything
 * else (a larger file, GIF, TIFF, HEIC) is turned into a WebP of at most
 * SHRINK_TO pixels on its longest side (the large size, if that is still too big).
 */
export async function prepareImage(file: Buffer): Promise<{ body: Buffer; contentType: AllowedImageType }> {
  let format: string | undefined;
  try {
    format = (await sharp(file, { failOn: "error", limitInputPixels: PIXEL_LIMIT }).metadata()).format;
  } catch {
    throw new RemoteImageError("The file is not a picture that can be read");
  }
  const kept = format ? STORED_AS[format] : undefined;
  if (kept && file.length <= MAX_IMAGE_BYTES) return { body: file, contentType: kept };
  // Smaller steps for very detailed pictures; the storefront never shows more than its large size anyway.
  for (const [side, quality] of [[SHRINK_TO, 85], [IMAGE_SIZES.large, 80], [IMAGE_SIZES.large, 60]] as const) {
    const body = await sharp(file, { failOn: "error", limitInputPixels: PIXEL_LIMIT })
      .rotate()
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();
    if (body.length <= MAX_IMAGE_BYTES) return { body, contentType: "image/webp" };
  }
  throw new RemoteImageError(`The picture is still larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB after shrinking`);
}
