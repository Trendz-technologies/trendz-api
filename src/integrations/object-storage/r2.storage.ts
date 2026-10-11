import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env";
import type { ObjectStorage, UploadTicket } from "./storage.types";

/**
 * Image storage on Cloudflare R2 through its S3-compatible API.
 * Locally the same code talks to the MinIO container.
 *
 * Only keys under `public/` are readable from outside (through R2_PUBLIC_URL,
 * cached by the CDN); a product photo under `uploads/` stays private and is
 * deleted once the worker has made its sizes.
 */
export class R2Storage implements ObjectStorage {
  readonly provider = "r2" as const;
  readonly enforcesUploadSize = true;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const endpoint = env.R2_ENDPOINT ?? (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_NAME) {
      throw new Error("Object storage is not configured (R2_ENDPOINT/R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME)");
    }
    this.bucket = env.R2_BUCKET_NAME;
    this.client = new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: env.R2_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
      // R2 does not support the newer default request checksums on presigned PUTs.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  async uploadTicket(key: string, contentType: string, contentLength: number, expiresInSeconds = 600): Promise<UploadTicket> {
    // ContentLength is part of the signature, so the client cannot upload a
    // different (larger) file than the one it declared.
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds, signableHeaders: new Set(["content-type", "content-length"]) });
    return { uploadUrl, method: "PUT", headers: { "Content-Type": contentType } };
  }

  presignGet(key: string, expiresInSeconds = 300, downloadName?: string) {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: downloadName ? `attachment; filename="${downloadName.replace(/"/g, "")}"` : undefined,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds });
  }

  async put(key: string, body: Buffer, contentType: string, cacheControl = "public, max-age=31536000, immutable") {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Object ${key} has no body`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async head(key: string) {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === "NotFound") return null;
      throw err;
    }
  }

  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      if (batch.length === 0) continue;
      await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  publicUrl(key: string) {
    if (!env.R2_PUBLIC_URL) throw new Error("R2_PUBLIC_URL is not configured");
    return `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
  }

  /** Exposed for the bucket bootstrap script. */
  get raw() {
    return { client: this.client, bucket: this.bucket };
  }
}
