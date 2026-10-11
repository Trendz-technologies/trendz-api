import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file runs the application with Cloudinary as its image storage. The
// account is made up and Cloudinary's HTTP API is played by the stand-in below,
// so nothing leaves the machine; what is tested is everything on our side of it.
const account = vi.hoisted(() => {
  const made = { cloud: "trendz-test", key: "614335564976464", secret: "a676b67565c6767a6767d6767f676fe1" };
  // Set one by one so that nothing in a developer's own .env (real keys, another folder) reaches these tests.
  Object.assign(process.env, {
    STORAGE_PROVIDER: "cloudinary",
    CLOUDINARY_URL: "",
    CLOUDINARY_CLOUD_NAME: made.cloud,
    CLOUDINARY_API_KEY: made.key,
    CLOUDINARY_API_SECRET: made.secret,
    CLOUDINARY_FOLDER: "trendz",
    CLOUDINARY_SIGNATURE_ALGORITHM: "sha1",
  });
  return made;
});

import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { CloudinaryStorage, cloudinarySignature } from "../src/integrations/object-storage/cloudinary.storage";
import { storage } from "../src/integrations/object-storage";
import { processImage } from "../src/modules/media/images.service";
import { makeProduct } from "./fixtures";
import { latestJob, loginAs, resetDatabase } from "./helpers";

interface Asset {
  bytes: number;
  width: number;
  height: number;
}

/** A stand-in for Cloudinary's API: it keeps assets in memory and refuses requests that are not signed correctly. */
function cloudinaryStandIn(options: { avif?: boolean } = {}) {
  const assets = new Map<string, Asset>();
  const calls: { action: string; params: Record<string, string> }[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.host === "api.cloudinary.com" && url.pathname.startsWith(`/v1_1/${account.cloud}/resources/image/upload/`)) {
      const expected = `Basic ${Buffer.from(`${account.key}:${account.secret}`).toString("base64")}`;
      if (new Headers(init?.headers).get("authorization") !== expected) return json(401, { error: { message: "Invalid credentials" } });
      const id = decodeURIComponent(url.pathname.split("/resources/image/upload/")[1]!);
      const asset = assets.get(id);
      return asset ? json(200, { public_id: id, format: "png", ...asset }) : json(404, { error: { message: `Resource not found - ${id}` } });
    }
    const action = new RegExp(`^/v1_1/${account.cloud}/image/(upload|explicit|destroy)$`).exec(url.pathname)?.[1];
    if (url.host !== "api.cloudinary.com" || !action || init?.method !== "POST") throw new Error(`Unexpected request to ${url.href}`);

    const body = init.body as unknown as FormData | URLSearchParams;
    const params: Record<string, string> = {};
    let file: Blob | null = null;
    if (body instanceof FormData) {
      for (const [name, value] of body.entries()) {
        if (typeof value === "string") params[name] = value;
        else file = value;
      }
    } else {
      for (const [name, value] of body.entries()) params[name] = value;
    }
    calls.push({ action, params });
    const { signature, api_key: apiKey, ...signedParams } = params;
    if (apiKey !== account.key || signature !== cloudinarySignature(signedParams, account.secret)) return json(401, { error: { message: "Invalid Signature" } });

    const id = params.public_id!;
    if (action === "upload") {
      if (!file) return json(400, { error: { message: "Missing required parameter - file" } });
      // Stands for a 2400 x 1800 photo whatever the bytes are.
      if (!(params.overwrite === "false" && assets.has(id))) assets.set(id, { bytes: file.size, width: 2400, height: 1800 });
      return json(200, { public_id: id, format: "png", ...assets.get(id)! });
    }
    if (action === "destroy") return json(200, { result: assets.delete(id) ? "ok" : "not found" });

    const asset = assets.get(id);
    if (!asset) return json(404, { error: { message: `Resource not found - ${id}` } });
    const eager = (params.eager ?? "").split("|").map((spec) => {
      const [transformation, format] = spec.split("/") as [string, string];
      if (format === "avif" && options.avif === false) return { status: "failed", reason: "AVIF is not available" };
      const box = Number(/w_(\d+)/.exec(transformation)![1]);
      const scale = Math.min(1, box / Math.max(asset.width, asset.height));
      return {
        transformation,
        format,
        width: Math.round(asset.width * scale),
        height: Math.round(asset.height * scale),
        secure_url: `https://res.cloudinary.com/${account.cloud}/image/upload/${transformation}/v1/${id}.${format}`,
      };
    });
    return json(200, { public_id: id, format: "png", ...asset, eager });
  };
  return { assets, calls, handler };
}

let cloudinary: ReturnType<typeof cloudinaryStandIn>;
const useStandIn = (options?: { avif?: boolean }) => {
  cloudinary = cloudinaryStandIn(options);
  vi.stubGlobal("fetch", vi.fn(cloudinary.handler));
};

/** One byte more than any upload may be. */
const OVER_LIMIT = 2 * 1024 * 1024 + 1;

/** What the admin's browser does with an upload ticket. */
async function browserUpload(ticket: { uploadUrl: string; method: string; fields: Record<string, string> }, bytes = 2048) {
  const form = new FormData();
  for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/png" }), "photo.png");
  return fetch(ticket.uploadUrl, { method: ticket.method, body: form });
}

beforeEach(async () => {
  await resetDatabase();
  useStandIn();
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeQueues);

describe("Cloudinary request signing", () => {
  it("matches the example in Cloudinary's documentation", () => {
    const params = { timestamp: "1315060510", public_id: "sample_image", eager: "w_400,h_300,c_pad|w_260,h_200,c_crop" };
    expect(cloudinarySignature(params, "abcd")).toBe("bfd09f95f331f558cbd1320e67aa8d488770583e");
    expect(cloudinarySignature(params, "abcd", "sha256")).toHaveLength(64);
  });

  it("stores each kind of key under one folder, without the file extension", () => {
    const store = new CloudinaryStorage({ cloudName: "c", apiKey: "k", apiSecret: "s", folder: "shops/trendz-dev", signatureAlgorithm: "sha1" });
    expect(store.publicId("uploads/products/p1/i1/mabc")).toBe("shops/trendz-dev/products/p1/i1/mabc");
    expect(store.publicId("public/brands/0a1b.png")).toBe("shops/trendz-dev/brands/0a1b");
    expect(store.publicId("public/content/hero.webp")).toBe("shops/trendz-dev/content/hero");
    expect(store.publicUrl("public/content/hero.webp")).toBe("https://res.cloudinary.com/c/image/upload/c_limit,f_auto,q_auto,w_1600/shops/trendz-dev/content/hero");
  });
});

describe("product photos on Cloudinary", () => {
  it("hands the browser a signed form, keeps the photo and takes its sizes from Cloudinary", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { product } = await makeProduct({ price: 79900 });

    const res = await admin
      .post(`/api/products/${product.id}/images/upload-url`)
      .send({ fileName: "kurti.png", contentType: "image/png", size: 2048, altText: "Kurti" })
      .expect(201);
    const ticket = res.body.data;
    const imageId = ticket.image.id as string;
    expect(ticket).toMatchObject({ method: "POST", uploadUrl: `https://api.cloudinary.com/v1_1/${account.cloud}/image/upload` });
    expect(ticket.fields).toMatchObject({ api_key: account.key, allowed_formats: "jpg,png,webp,avif", overwrite: "false", asset_folder: `trendz/products/${product.id}/${imageId}` });
    expect(ticket.fields.public_id).toMatch(new RegExp(`^trendz/products/${product.id}/${imageId}/[a-z0-9]+$`));
    // The browser gets a signature for this one upload, never the secret that made it.
    expect(JSON.stringify(res.body)).not.toContain(account.secret);

    // Finishing before the file is there is refused.
    await admin.post(`/api/products/${product.id}/images/${imageId}/complete`).send({}).expect(400);
    expect((await browserUpload(ticket)).status).toBe(200);
    await admin.post(`/api/products/${product.id}/images/${imageId}/complete`).send({}).expect(200);
    expect((await latestJob("media", "image.process"))?.data).toEqual({ imageId });

    await processImage(imageId); // what the worker does
    const img = await prisma.productImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(img.status).toBe("READY");
    expect([img.width, img.height]).toEqual([1600, 1200]);
    const sizes = img.sizes as Record<string, { key: string; url: string; width: number; height: number }>;
    expect(Object.keys(sizes).sort()).toEqual(["large", "largeAvif", "medium", "mediumAvif", "thumb"]);
    expect(sizes.thumb).toMatchObject({ width: 320, height: 240, url: `https://res.cloudinary.com/${account.cloud}/image/upload/c_limit,h_320,q_auto,w_320/v1/${ticket.fields.public_id}.webp` });
    expect(sizes.largeAvif!.url.endsWith(".avif")).toBe(true);
    expect(img.url).toBe(sizes.large!.url);
    // Every size is made from the stored photo, so the photo is kept and they all share its key.
    expect(new Set(Object.values(sizes).map((s) => s.key))).toEqual(new Set([img.objectKey]));
    expect(cloudinary.assets.has(ticket.fields.public_id)).toBe(true);

    const view = (await admin.get(`/api/products/${product.id}`).expect(200)).body.data.images[0];
    expect(view).toMatchObject({ status: "READY", thumb: sizes.thumb!.url, medium: sizes.medium!.url, avif: { large: sizes.largeAvif!.url } });
  });

  it("removes the old photo once a replacement is ready, and the photo itself when the image is deleted", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { product } = await makeProduct({ price: 79900 });
    const first = (await admin.post(`/api/products/${product.id}/images/upload-url`).send({ fileName: "a.png", contentType: "image/png", size: 2048 }).expect(201)).body.data;
    const imageId = first.image.id as string;
    await browserUpload(first);
    await admin.post(`/api/products/${product.id}/images/${imageId}/complete`).send({}).expect(200);
    await processImage(imageId);

    await new Promise((r) => setTimeout(r, 5)); // the key of an upload carries its time
    const second = (await admin.post(`/api/products/${product.id}/images/${imageId}/replace`).send({ fileName: "b.png", contentType: "image/png", size: 4096 }).expect(200)).body.data;
    expect(second.fields.public_id).not.toBe(first.fields.public_id);
    await browserUpload(second, 4096);
    await admin.post(`/api/products/${product.id}/images/${imageId}/complete`).send({}).expect(200);
    // Until the new sizes exist the image keeps showing the old photo.
    expect(cloudinary.assets.has(first.fields.public_id)).toBe(true);
    await processImage(imageId);
    expect([...cloudinary.assets.keys()]).toEqual([second.fields.public_id]);

    // A job that runs twice must not delete the photo it has just made the sizes from.
    await prisma.productImage.update({ where: { id: imageId }, data: { status: "PROCESSING" } });
    await processImage(imageId);
    expect([...cloudinary.assets.keys()]).toEqual([second.fields.public_id]);

    await admin.delete(`/api/products/${product.id}/images/${imageId}`).expect(200);
    const job = await latestJob("media", "image.delete-objects");
    cloudinary.calls.length = 0;
    await storage().delete((job!.data as { keys: string[] }).keys); // what the worker does
    expect(cloudinary.calls.map((c) => c.action)).toEqual(["destroy"]); // one asset, however many sizes pointed at it
    expect(cloudinary.calls[0]!.params).toMatchObject({ public_id: second.fields.public_id, invalidate: "true" });
    expect(cloudinary.assets.size).toBe(0);
  });

  it("is ready with WebP only when Cloudinary cannot make the AVIF copies", async () => {
    useStandIn({ avif: false });
    const { client: admin } = await loginAs(["ADMIN"]);
    const { product } = await makeProduct({ price: 79900 });
    const ticket = (await admin.post(`/api/products/${product.id}/images/upload-url`).send({ fileName: "a.png", contentType: "image/png", size: 2048 }).expect(201)).body.data;
    await browserUpload(ticket);
    await admin.post(`/api/products/${product.id}/images/${ticket.image.id}/complete`).send({}).expect(200);
    await processImage(ticket.image.id);

    const view = (await admin.get(`/api/products/${product.id}`).expect(200)).body.data.images[0];
    expect(view.status).toBe("READY");
    expect(view.large).toContain(".webp");
    expect(view.avif).toEqual({ medium: null, large: null });
  });

  it("refuses and removes a photo that turns out to be over 2 MB", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const { product } = await makeProduct({ price: 79900 });
    // Cloudinary does not hold an upload to the size the ticket was asked for, so the real size is checked on completion.
    const ticket = (await admin.post(`/api/products/${product.id}/images/upload-url`).send({ fileName: "a.png", contentType: "image/png", size: 2048 }).expect(201)).body.data;
    await browserUpload(ticket, OVER_LIMIT);
    const refused = await admin.post(`/api/products/${product.id}/images/${ticket.image.id}/complete`).send({}).expect(400);
    expect(refused.body).toMatchObject({ code: "IMAGE_TOO_LARGE", message: "Images must be at most 2 MB" });
    expect(cloudinary.assets.size).toBe(0);
  });
});

describe("category, brand and content pictures on Cloudinary", () => {
  it("issues a signed form and saves a Cloudinary address on the record", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const ticket = (await admin.post("/api/uploads/presign").send({ purpose: "category", contentType: "image/jpeg", size: 50_000 }).expect(200)).body.data;
    const id = /^public\/categories\/([\w-]+)\.jpg$/.exec(ticket.key)![1];
    expect(ticket).toMatchObject({ method: "POST", publicUrl: `https://res.cloudinary.com/${account.cloud}/image/upload/c_limit,f_auto,q_auto,w_1600/trendz/categories/${id}` });
    expect(ticket.fields.public_id).toBe(`trendz/categories/${id}`);
    expect((await browserUpload(ticket)).status).toBe(200);

    const category = (await admin.post("/api/categories").send({ name: "Kurti Sets", imageKey: ticket.key }).expect(201)).body.data;
    expect(category.imageUrl).toBe(ticket.publicUrl);
  });

  it("refuses a form whose fields were changed after it was signed", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const ticket = (await admin.post("/api/uploads/presign").send({ purpose: "brand", contentType: "image/png", size: 9000 }).expect(200)).body.data;
    const tampered = { ...ticket, fields: { ...ticket.fields, public_id: "trendz/brands/someone-elses-logo" } };
    expect((await browserUpload(tampered)).status).toBe(401);
    expect(cloudinary.assets.size).toBe(0);
  });

  it("refuses and removes a picture over 2 MB when it is saved on a category, a brand or a content page", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const oversized = async (purpose: "category" | "brand" | "content") => {
      const ticket = (await admin.post("/api/uploads/presign").send({ purpose, contentType: "image/png", size: 9000 }).expect(200)).body.data;
      await browserUpload(ticket, OVER_LIMIT);
      return ticket.key as string;
    };
    const tooLarge = { code: "IMAGE_TOO_LARGE", message: "Images must be at most 2 MB" };

    // Each picture is uploaded before the request that saves it is started.
    const imageKey = await oversized("category");
    expect((await admin.post("/api/categories").send({ name: "Lehenga", imageKey }).expect(400)).body).toMatchObject(tooLarge);
    const logoKey = await oversized("brand");
    expect((await admin.post("/api/brands").send({ name: "Trendz Studio", logoKey }).expect(400)).body).toMatchObject(tooLarge);
    const about = (await admin.get("/api/settings/aboutPage").expect(200)).body.data.value;
    const contentKey = await oversized("content");
    expect((await admin.put("/api/settings/aboutPage").send({ ...about, imageKey: contentKey }).expect(400)).body).toMatchObject(tooLarge);
    expect(cloudinary.assets.size).toBe(0);

    // A picture within the limit is saved, and saving the record again does not look it up a second time.
    const ticket = (await admin.post("/api/uploads/presign").send({ purpose: "content", contentType: "image/png", size: 9000 }).expect(200)).body.data;
    await browserUpload(ticket, 2 * 1024 * 1024);
    const saved = (await admin.put("/api/settings/aboutPage").send({ ...about, imageKey: ticket.key }).expect(200)).body.data;
    const lookups = vi.mocked(fetch).mock.calls.length;
    await admin.put("/api/settings/aboutPage").send({ ...saved, intro: { en: "A boutique in Kunnathur.", ta: "" } }).expect(200);
    expect(vi.mocked(fetch).mock.calls.length).toBe(lookups);
  });
});

// Last in the file: these reload the settings module, which the tests above must not see.
describe("Cloudinary settings", () => {
  // Loads the settings afresh with other values, the way a new process would, and puts everything back.
  const load = async (vars: Record<string, string>) => {
    const changed = { CLOUDINARY_CLOUD_NAME: "", CLOUDINARY_API_KEY: "", CLOUDINARY_API_SECRET: "", ...vars };
    const before = Object.fromEntries(Object.keys(changed).map((name) => [name, process.env[name]]));
    Object.assign(process.env, changed);
    vi.resetModules();
    try {
      return (await import("../src/config/env.js")).env;
    } finally {
      Object.assign(process.env, before);
    }
  };

  it("takes the three values from the one line the Cloudinary console shows", async () => {
    const env = await load({ CLOUDINARY_URL: "cloudinary://123456789012345:AbCd-EfGh_IjKlMnOpQrStUvWx@my-shop" });
    expect([env.CLOUDINARY_CLOUD_NAME, env.CLOUDINARY_API_KEY, env.CLOUDINARY_API_SECRET]).toEqual(["my-shop", "123456789012345", "AbCd-EfGh_IjKlMnOpQrStUvWx"]);
  });

  it("refuses to start with Cloudinary chosen and no keys, and never echoes a malformed line", async () => {
    await expect(load({ CLOUDINARY_URL: "" })).rejects.toThrow(/STORAGE_PROVIDER=cloudinary requires/);
    const failure = await load({ CLOUDINARY_URL: "https://123:super-secret-value@my-shop" }).catch((err: Error) => err.message);
    expect(failure).toMatch(/CLOUDINARY_URL: expected cloudinary:\/\//);
    expect(failure).not.toContain("super-secret-value");
  });
});
