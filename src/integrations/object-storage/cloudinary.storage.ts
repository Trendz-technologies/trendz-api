import { createHash } from "node:crypto";
import type { ObjectStorage, Rendition, RenditionSpec, StoredObject, UploadTicket } from "./storage.types";

/**
 * Image storage on Cloudinary, through its REST API (no SDK needed).
 *
 * A storage key becomes the asset's public ID inside one folder of the
 * account: `uploads/products/<p>/<i>/<v>` is stored as
 * `<folder>/products/<p>/<i>/<v>` and `public/brands/<id>.png` as
 * `<folder>/brands/<id>`. Cloudinary keeps the file as uploaded and makes the
 * sizes the storefront needs from it, so an uploaded product photo is kept
 * (on R2 it is replaced by the sizes the worker makes).
 *
 * The API secret signs requests here and never leaves the server: the browser
 * only receives a signature that is valid for one upload under one public ID.
 */
export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Folder that holds every asset of this environment, e.g. `trendz` or `trendz-dev`. */
  folder: string;
  /** Must match the account's setting (Settings → Security); SHA-1 unless it was changed. */
  signatureAlgorithm: "sha1" | "sha256";
}

const API = "https://api.cloudinary.com/v1_1";
const DELIVERY = "https://res.cloudinary.com";
const IMAGE_EXTENSION = /\.(jpe?g|png|webp|avif)$/i;
/** What a browser upload may contain (Cloudinary rejects anything else). */
const UPLOAD_FORMATS = "jpg,png,webp,avif";
/** Category, brand and content pictures: best format and quality for the browser, at most 1600px wide. */
const PUBLIC_DELIVERY = "c_limit,f_auto,q_auto,w_1600";
const TIMEOUT_MS = 60_000;

export class CloudinaryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Cloudinary: ${message}`);
    this.name = "CloudinaryError";
  }
}

/** Cloudinary's request signature: the parameters sorted by name, joined, with the API secret appended, hashed. */
export function cloudinarySignature(params: Record<string, string>, apiSecret: string, algorithm: "sha1" | "sha256" = "sha1"): string {
  const payload = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return createHash(algorithm)
    .update(payload + apiSecret)
    .digest("hex");
}

interface AssetResponse {
  bytes?: number;
  format?: string;
  eager?: { secure_url?: string; width?: number; height?: number }[];
}

export class CloudinaryStorage implements ObjectStorage {
  readonly provider = "cloudinary" as const;
  readonly enforcesUploadSize = false;

  constructor(
    private readonly config: CloudinaryConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** The public ID an asset is stored under for one of our storage keys. */
  publicId(key: string): string {
    return `${this.config.folder}/${key.replace(/^(uploads|public)\//, "").replace(IMAGE_EXTENSION, "")}`;
  }

  private pathOf(key: string) {
    return this.publicId(key).split("/").map(encodeURIComponent).join("/");
  }

  /** The parameters of one API call with the time, the signature and the (public) API key added. */
  private signed(params: Record<string, string>): Record<string, string> {
    const stamped = { ...params, timestamp: String(Math.floor(this.now() / 1000)) };
    return { ...stamped, signature: cloudinarySignature(stamped, this.config.apiSecret, this.config.signatureAlgorithm), api_key: this.config.apiKey };
  }

  /**
   * Where the asset goes: its public ID, and the same folder in the Media
   * Library. `asset_folder` is what places it there on accounts in dynamic
   * folder mode (every account created since 2023); older fixed-folder
   * accounts take the folder from the public ID and have no use for it.
   */
  private placement(key: string) {
    const publicId = this.publicId(key);
    return { public_id: publicId, asset_folder: publicId.slice(0, publicId.lastIndexOf("/")) };
  }

  private async call<T>(action: string, body: FormData | URLSearchParams): Promise<T> {
    const res = await fetch(`${API}/${this.config.cloudName}/image/${action}`, { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!res.ok || !json) throw new CloudinaryError(res.status, json?.error?.message ?? `the ${action} request failed (HTTP ${res.status})`);
    return json;
  }

  uploadTicket(key: string): Promise<UploadTicket> {
    // The signature covers the public ID and the allowed formats, so the browser can upload this one image and nothing else.
    const fields = this.signed({ ...this.placement(key), allowed_formats: UPLOAD_FORMATS, overwrite: "false" });
    return Promise.resolve({ uploadUrl: `${API}/${this.config.cloudName}/image/upload`, method: "POST", headers: {}, fields });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const form = new FormData();
    for (const [name, value] of Object.entries(this.signed({ ...this.placement(key), overwrite: "true", invalidate: "true" }))) form.set(name, value);
    form.set("file", new Blob([new Uint8Array(body)], { type: contentType }), "upload");
    await this.call("upload", form);
  }

  async get(key: string): Promise<Buffer> {
    // No transformation in the address: Cloudinary returns the file as it was uploaded.
    const res = await fetch(`${DELIVERY}/${this.config.cloudName}/image/upload/${this.pathOf(key)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new CloudinaryError(res.status, `could not read ${this.publicId(key)} (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async head(key: string): Promise<StoredObject | null> {
    const res = await fetch(`${API}/${this.config.cloudName}/resources/image/upload/${this.pathOf(key)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString("base64")}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => null)) as (AssetResponse & { error?: { message?: string } }) | null;
    if (!res.ok || !json) throw new CloudinaryError(res.status, json?.error?.message ?? `could not look up ${this.publicId(key)} (HTTP ${res.status})`);
    return { size: json.bytes ?? 0, contentType: json.format ? `image/${json.format === "jpg" ? "jpeg" : json.format}` : null };
  }

  async delete(keys: string[]): Promise<void> {
    // Several keys can name one asset (a photo and the sizes made from it).
    for (const publicId of new Set(keys.map((key) => this.publicId(key)))) {
      // `invalidate` also clears the copies cached on the CDN. An asset that is not there answers "not found", which is fine.
      await this.call("destroy", new URLSearchParams(this.signed({ public_id: publicId, invalidate: "true" })));
    }
  }

  publicUrl(key: string): string {
    return `${DELIVERY}/${this.config.cloudName}/image/upload/${PUBLIC_DELIVERY}/${this.pathOf(key)}`;
  }

  async renditions(key: string, specs: RenditionSpec[]): Promise<(Rendition | null)[]> {
    // `c_limit` fits the picture inside the box without enlarging it; the part after the slash is the file format.
    const eager = specs.map((spec) => `c_limit,h_${spec.width},q_auto,w_${spec.width}/${spec.format}`).join("|");
    // Made now rather than on the first visit, and the answer carries each copy's real size.
    const asset = await this.call<AssetResponse>("explicit", new URLSearchParams(this.signed({ public_id: this.publicId(key), type: "upload", eager })));
    return specs.map((_, i) => {
      const made = asset.eager?.[i];
      return made?.secure_url && made.width && made.height ? { key, url: made.secure_url, width: made.width, height: made.height } : null;
    });
  }
}
