/**
 * Checks the image storage this environment is set up for (STORAGE_PROVIDER),
 * end to end, with a small test picture that is removed again:
 *
 *   upload from the server → look it up → read it through its public address
 *   → make the storefront sizes (Cloudinary) → upload the way a browser does → delete
 *
 * Run it after putting the storage credentials in .env:  npm run storage:check
 * Nothing secret is printed.
 */
import sharp from "sharp";
import { env } from "../src/config/env";
import { storage, type UploadTicket } from "../src/integrations/object-storage";

/** What the admin's upload helper does with a ticket (src/lib/upload.ts in the web repository). */
async function uploadLikeABrowser(ticket: UploadTicket, file: Buffer, contentType: string) {
  const blob = new Blob([new Uint8Array(file)], { type: contentType });
  let res: Response;
  if (ticket.fields) {
    const form = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) form.append(name, value);
    form.append("file", blob, "check.png");
    res = await fetch(ticket.uploadUrl, { method: "POST", body: form });
  } else {
    res = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body: blob });
  }
  if (!res.ok) {
    const reason = await res.json().then(
      (body) => (body as { error?: { message?: string } } | null)?.error?.message,
      () => undefined,
    );
    throw new Error(reason ?? `HTTP ${res.status}`);
  }
}

async function main() {
  const store = storage();
  const where = store.provider === "cloudinary" ? `cloud "${env.CLOUDINARY_CLOUD_NAME}", folder "${env.CLOUDINARY_FOLDER}"` : `${env.R2_ENDPOINT ?? "Cloudflare R2"}, bucket "${env.R2_BUCKET_NAME}"`;
  console.log(`Image storage: ${store.provider} (${where})\n`);

  const png = await sharp({ create: { width: 640, height: 800, channels: 3, background: "#ff3d9a" } })
    .png()
    .toBuffer();
  const stamp = Date.now().toString(36);
  const serverKey = `public/content/zz-storage-check-${stamp}.png`;
  const browserKey = `uploads/products/zz-storage-check/${stamp}/original`;

  let failures = 0;
  const step = async (label: string, run: () => Promise<string | void>) => {
    try {
      const note = await run();
      console.log(`✔ ${label}${note ? ` — ${note}` : ""}`);
    } catch (err) {
      failures++;
      console.error(`✘ ${label}: ${(err as Error).message}`);
    }
  };

  await step("upload from the server", () => store.put(serverKey, png, "image/png"));
  await step("look the file up", async () => {
    const found = await store.head(serverKey);
    if (!found) throw new Error("it is not there after the upload");
    return `${found.size} bytes, ${found.contentType ?? "unknown type"}`;
  });
  await step("read it through its public address", async () => {
    const url = store.publicUrl(serverKey);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) throw new Error(`expected a picture, got "${type}" from ${url}`);
    return url;
  });
  await step("upload the way a browser does (signed ticket)", async () => {
    await uploadLikeABrowser(await store.uploadTicket(browserKey, "image/png", png.length), png, "image/png");
    if (!(await store.head(browserKey))) throw new Error("the upload was accepted but the file is not there");
  });
  if (store.renditions) {
    await step("make the storefront sizes from the uploaded photo", async () => {
      const [webp, avif] = await store.renditions!(browserKey, [
        { width: 320, format: "webp" },
        { width: 320, format: "avif" },
      ]);
      if (!webp) throw new Error("no WebP copy came back");
      const res = await fetch(webp.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${webp.url}`);
      return `WebP ${webp.width}×${webp.height}${avif ? `, AVIF ${avif.width}×${avif.height}` : ", no AVIF copy (the storefront then uses WebP)"}`;
    });
  }
  await step("delete the test files", async () => {
    await store.delete([serverKey, browserKey]);
    if ((await store.head(serverKey)) || (await store.head(browserKey))) throw new Error("a test file is still there");
  });

  console.log(failures ? `\n${failures} step${failures === 1 ? "" : "s"} failed.` : "\nImage storage works.");
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
