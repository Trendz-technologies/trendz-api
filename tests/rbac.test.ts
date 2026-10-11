import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/database/prisma";
import { closeQueues } from "../src/jobs/queues";
import { client, createUser, loginAs, resetDatabase } from "./helpers";

beforeEach(resetDatabase);
afterAll(closeQueues);

describe("authorization", () => {
  it("requires authentication for admin routes", async () => {
    const c = await client();
    const res = await c.get("/api/users").expect(401);
    expect(res.body).toMatchObject({ success: false, code: "UNAUTHENTICATED" });
  });

  it("blocks customers and under-privileged staff", async () => {
    const { client: customer } = await loginAs(["CUSTOMER"]);
    await customer.get("/api/users").expect(403);

    const { client: cashier } = await loginAs(["CASHIER"]);
    await cashier.get("/api/users").expect(403);
    await cashier.get("/api/settings").expect(403);
  });

  it("lets an admin manage staff and records an audit trail", async () => {
    const { client: admin, user: adminUser } = await loginAs(["ADMIN"]);
    const created = await admin
      .post("/api/users")
      .send({ email: "cashier@test.local", firstName: "Ravi", password: "Cashier123", roleCodes: ["CASHIER"] })
      .expect(201);
    expect(created.body.data.roles.map((r: { code: string }) => r.code)).toEqual(["CASHIER"]);

    const id = created.body.data.id;
    await admin.put(`/api/users/${id}/roles`).send({ roleCodes: ["CASHIER", "SUPPORT"] }).expect(200);

    const logs = await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.action)).toEqual(["user.create", "user.roles.update"]);
    expect(logs[1]!.userId).toBe(adminUser.id);
    expect(logs[1]!.oldValue).toEqual(["CASHIER"]);
  });

  it("only a super admin can grant super admin", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const target = await createUser({ roles: ["SUPPORT"] });
    const res = await admin.put(`/api/users/${target.id}/roles`).send({ roleCodes: ["SUPER_ADMIN"] }).expect(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("applies role permission changes immediately (cache invalidation)", async () => {
    const { client: support } = await loginAs(["SUPPORT"]);
    await support.get("/api/audit-logs").expect(403);

    const { client: superAdmin } = await loginAs(["SUPER_ADMIN"]);
    const roles = await superAdmin.get("/api/roles").expect(200);
    const supportRole = roles.body.data.find((r: { code: string }) => r.code === "SUPPORT");
    await superAdmin
      .put(`/api/roles/${supportRole.id}`)
      .send({ name: supportRole.name, permissions: [...supportRole.permissions, "audit.read"] })
      .expect(200);

    await support.get("/api/audit-logs").expect(200);
  });

  it("disabling a user signs them out everywhere", async () => {
    const { client: staffClient, user: staff } = await loginAs(["SUPPORT"]);
    await staffClient.get("/api/auth/me").expect(200);
    const { client: admin } = await loginAs(["ADMIN"]);
    await admin.post(`/api/users/${staff.id}/status`).send({ status: "DISABLED" }).expect(200);
    await staffClient.get("/api/auth/me").expect(401);
  });

  it("settings are validated and audited", async () => {
    const { client: admin } = await loginAs(["ADMIN"]);
    const bad = await admin.put("/api/settings/checkout").send({ reservationTtlMinutes: 1 }).expect(400);
    expect(bad.body.code).toBe("VALIDATION_ERROR");
    const good = await admin.put("/api/settings/checkout").send({ reservationTtlMinutes: 20 }).expect(200);
    expect(good.body.data).toMatchObject({ reservationTtlMinutes: 20, allowGuestCheckout: false });
    expect(await prisma.auditLog.count({ where: { action: "settings.update" } })).toBe(1);
  });

  it("appearance: defaults to dark pink, validates colours and reaches the public config", async () => {
    const anonymous = await client();
    const before = await anonymous.get("/api/store/config").expect(200);
    expect(before.body.data.appearance).toEqual({ mode: "dark", brandColor: "#ff3d9a", textColor: null });

    const { client: admin } = await loginAs(["ADMIN"]);
    const unsaved = await admin.get("/api/settings/appearance").expect(200);
    expect(unsaved.body.data).toMatchObject({ key: "appearance", updatedAt: null, updatedBy: null });

    for (const brandColor of ["pink", "#f0a", "#ff3d9a80", "javascript:alert(1)"]) {
      const bad = await admin.put("/api/settings/appearance").send({ mode: "dark", brandColor }).expect(400);
      expect(bad.body.code).toBe("VALIDATION_ERROR");
    }
    await admin.put("/api/settings/appearance").send({ mode: "sepia", brandColor: "#0f766e" }).expect(400);

    const saved = await admin.put("/api/settings/appearance").send({ mode: "light", brandColor: "#0F766E", textColor: "#1B2430" }).expect(200);
    expect(saved.body.data).toEqual({ mode: "light", brandColor: "#0f766e", textColor: "#1b2430" });

    const record = await admin.get("/api/settings/appearance").expect(200);
    expect(record.body.data.value).toEqual(saved.body.data);
    expect(record.body.data.updatedAt).toEqual(expect.any(String));
    expect(record.body.data.updatedBy).toMatch(/^Test User\d+$/);

    // Visible to anonymous visitors straight away (the settings cache is invalidated on save).
    const after = await anonymous.get("/api/store/config").expect(200);
    expect(after.body.data.appearance).toEqual(saved.body.data);

    // Staff without settings.write cannot change the theme.
    const { client: cashier } = await loginAs(["CASHIER"]);
    await cashier.put("/api/settings/appearance").send({ mode: "dark", brandColor: "#000000" }).expect(403);
  });

  it("home page offers: bilingual content is validated, published and hidden when switched off", async () => {
    const anonymous = await client();
    const before = await anonymous.get("/api/store/config").expect(200);
    expect(before.body.data.homeOffers).toMatchObject({ enabled: true, title: { en: expect.any(String), ta: expect.any(String) } });
    expect(before.body.data.homeOffers.cards[0]).toMatchObject({ price: 89900, imageKey: null, imageUrl: null });

    const { client: admin } = await loginAs(["ADMIN"]);
    const offers = (await admin.get("/api/settings/homeOffers").expect(200)).body.data.value;

    // Links must stay on the site, pictures must come from the upload endpoint, dates must be in order.
    for (const href of ["https://evil.example", "//evil.example", "javascript:alert(1)"]) {
      await admin.put("/api/settings/homeOffers").send({ ...offers, sale: { ...offers.sale, href } }).expect(400);
    }
    await admin.put("/api/settings/homeOffers").send({ ...offers, cards: [{ ...offers.cards[0], imageKey: "https://evil.example/x.png" }] }).expect(400);
    await admin.put("/api/settings/homeOffers").send({ ...offers, startsOn: "2026-10-19", endsOn: "2026-10-12" }).expect(400);
    await admin.put("/api/settings/homeOffers").send({ ...offers, cards: Array.from({ length: 5 }, () => offers.cards[0]) }).expect(400);

    const card = { tag: { en: "New", ta: "புதியது" }, title: { en: "Kurti set", ta: "குர்த்தீ செட்" }, caption: { en: "From", ta: "" }, price: 129900, href: "/category/kurti-sets", imageKey: "public/content/abc.webp" };
    const saved = await admin.put("/api/settings/homeOffers").send({ ...offers, cards: [card], endsOn: null }).expect(200);
    expect(saved.body.data.cards).toEqual([{ ...card, imageUrl: expect.stringMatching(/\/public\/content\/abc\.webp$/) }]);

    const after = await anonymous.get("/api/store/config").expect(200);
    expect(after.body.data.homeOffers.cards).toEqual(saved.body.data.cards);

    await admin.put("/api/settings/homeOffers").send({ ...saved.body.data, enabled: false }).expect(200);
    expect((await anonymous.get("/api/store/config").expect(200)).body.data.homeOffers).toBeNull();

    const { client: cashier } = await loginAs(["CASHIER"]);
    await cashier.put("/api/settings/homeOffers").send(offers).expect(403);
    await cashier.post("/api/uploads/presign").send({ purpose: "content", contentType: "image/webp", size: 1000 }).expect(403);
  });

  it("CMS: home page sections, contact details, legal pages and the About us page are validated and published", async () => {
    const anonymous = await client();
    const before = (await anonymous.get("/api/store/config").expect(200)).body.data;
    expect(before.home.hero).toMatchObject({ titleTop: { en: "Luxury in", ta: expect.any(String) }, primaryHref: "/products", imageKey: null, imageUrl: null });
    expect(before.home.editorial.points).toHaveLength(3);
    // No logo uploaded yet: the storefront shows the one that ships with it.
    expect(before.home.logo).toEqual({ imageKey: null, imageUrl: null });
    expect(before.contact).toMatchObject({ phone: "+91 93607 34597", instagram: "trendz_womenswear_", email: "" });
    // Legal pages start as empty drafts: not listed and not readable.
    expect(before.pages).toEqual([]);
    await anonymous.get("/api/store/pages/terms").expect(404);
    await anonymous.get("/api/store/pages/refunds").expect(404);

    const { client: admin } = await loginAs(["ADMIN"]);

    // Home page: a section can be hidden and reworded; links stay on the site, pictures come from the upload endpoint.
    const home = (await admin.get("/api/settings/homePage").expect(200)).body.data.value;
    await admin.put("/api/settings/homePage").send({ ...home, hero: { ...home.hero, primaryHref: "https://evil.example" } }).expect(400);
    await admin.put("/api/settings/homePage").send({ ...home, hero: { ...home.hero, imageKey: "https://evil.example/x.png" } }).expect(400);
    await admin.put("/api/settings/homePage").send({ ...home, editorial: { ...home.editorial, points: Array.from({ length: 4 }, () => ({ en: "x", ta: "" })) } }).expect(400);
    const savedHome = await admin
      .put("/api/settings/homePage")
      .send({ ...home, hero: { ...home.hero, titleTop: { en: "Festive", ta: "பண்டிகை" }, imageKey: "public/content/hero.webp" }, popular: { ...home.popular, enabled: false } })
      .expect(200);
    expect(savedHome.body.data.hero.imageUrl).toMatch(/\/public\/content\/hero\.webp$/);
    // The shop's logo is uploaded on the same screen and reaches every storefront page through the store config.
    await admin.put("/api/settings/homePage").send({ ...home, logo: { imageKey: "https://evil.example/logo.png" } }).expect(400);
    const withLogo = await admin.put("/api/settings/homePage").send({ ...home, logo: { imageKey: "public/content/logo.png" } }).expect(200);
    expect(withLogo.body.data.logo.imageUrl).toMatch(/\/public\/content\/logo\.png$/);
    expect((await anonymous.get("/api/store/config").expect(200)).body.data.home.logo).toEqual({ imageKey: "public/content/logo.png", imageUrl: withLogo.body.data.logo.imageUrl });
    // A section saved before a field existed still gets that field's default.
    await admin.put("/api/settings/homePage").send({ closing: { enabled: false } }).expect(200);
    const afterHome = (await anonymous.get("/api/store/config").expect(200)).body.data.home;
    expect(afterHome.closing).toMatchObject({ enabled: false, buttonHref: "/products" });
    expect(afterHome.hero.titleTop.en).toBe("Luxury in");

    // Contact details.
    const contact = (await admin.get("/api/settings/contact").expect(200)).body.data.value;
    for (const bad of [{ phone: "call me" }, { whatsapp: "<script>" }, { email: "nobody" }, { instagram: "https://instagram.com/trendz" }, { mapUrl: "javascript:alert(1)" }, { mapUrl: "http://maps.example" }]) {
      await admin.put("/api/settings/contact").send({ ...contact, ...bad }).expect(400);
    }
    const details = { phone: "+91 98765 43210", whatsapp: "", email: "hello@trendz.example", mapUrl: "https://maps.app.goo.gl/abc", hours: { en: "Mon–Sat 10am–9pm\nSun 10am–2pm", ta: "" } };
    await admin.put("/api/settings/contact").send({ ...contact, ...details }).expect(200);
    expect((await anonymous.get("/api/store/config").expect(200)).body.data.contact).toMatchObject(details);

    // Legal pages: nothing to publish until something is written; markup is cleaned before it is stored.
    const terms = (await admin.get("/api/settings/termsPage").expect(200)).body.data.value;
    expect(terms).toMatchObject({ published: false, title: { en: "Terms & Conditions" }, body: { en: "", ta: "" } });
    await admin.put("/api/settings/termsPage").send({ ...terms, published: true }).expect(400);
    await admin.put("/api/settings/termsPage").send({ ...terms, published: true, body: { en: "<p><br></p>", ta: "" } }).expect(400);

    const body = { en: '<h3>Orders</h3><p onclick="x()">All sales are <strong>final</strong>.</p><script>alert(1)</script><img src="x" onerror="alert(1)">', ta: "" };
    const draft = await admin.put("/api/settings/termsPage").send({ ...terms, body }).expect(200);
    expect(draft.body.data.body.en).toBe("<h3>Orders</h3><p>All sales are <strong>final</strong>.</p>");
    await anonymous.get("/api/store/pages/terms").expect(404);

    await admin.put("/api/settings/termsPage").send({ ...draft.body.data, published: true }).expect(200);
    const page = (await anonymous.get("/api/store/pages/terms").expect(200)).body.data;
    expect(page).toEqual({ slug: "terms", title: terms.title, body: draft.body.data.body, updatedAt: expect.any(String) });
    expect((await anonymous.get("/api/store/config").expect(200)).body.data.pages).toEqual([{ slug: "terms", title: terms.title }]);
    await anonymous.get("/api/store/pages/privacy").expect(404);

    // About us: written and shown from the start. Its picture and markup follow the same rules; switched off, it is gone from the store.
    expect(before.aboutPublished).toBe(true);
    const about = (await admin.get("/api/settings/aboutPage").expect(200)).body.data.value;
    expect(about).toMatchObject({ published: true, title: { en: "About Trendz" }, imageKey: null, imageUrl: null });
    expect(about.body.en).toContain("<h3>Luxury in every stitch</h3>");
    expect((await anonymous.get("/api/store/about").expect(200)).body.data).toMatchObject({ eyebrow: about.eyebrow, title: about.title, intro: about.intro, body: about.body, imageUrl: null });
    await admin.put("/api/settings/aboutPage").send({ ...about, imageKey: "https://evil.example/x.png" }).expect(400);
    await admin.put("/api/settings/aboutPage").send({ ...about, body: { en: "", ta: "" } }).expect(400);
    const savedAbout = await admin
      .put("/api/settings/aboutPage")
      .send({ ...about, imageKey: "public/content/shop.webp", body: { en: "<p>Our shop</p><script>alert(1)</script>", ta: "" } })
      .expect(200);
    expect(savedAbout.body.data.imageUrl).toMatch(/\/public\/content\/shop\.webp$/);
    const shownAbout = (await anonymous.get("/api/store/about").expect(200)).body.data;
    expect(shownAbout).toMatchObject({ body: { en: "<p>Our shop</p>", ta: "" }, imageUrl: savedAbout.body.data.imageUrl, updatedAt: expect.any(String) });
    expect(shownAbout).not.toHaveProperty("imageKey");
    await admin.put("/api/settings/aboutPage").send({ ...savedAbout.body.data, published: false }).expect(200);
    await anonymous.get("/api/store/about").expect(404);
    expect((await anonymous.get("/api/store/config").expect(200)).body.data.aboutPublished).toBe(false);

    const { client: cashier } = await loginAs(["CASHIER"]);
    await cashier.put("/api/settings/homePage").send(home).expect(403);
    await cashier.put("/api/settings/termsPage").send(terms).expect(403);
    await cashier.put("/api/settings/aboutPage").send(about).expect(403);
  });
});

describe("customer account", () => {
  it("manages addresses and derives the GST state code server-side", async () => {
    const { client: c } = await loginAs(["CUSTOMER"]);
    const res = await c
      .post("/api/account/addresses")
      .send({ fullName: "Asha Rao", phone: "9876501234", line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001" })
      .expect(201);
    expect(res.body.data).toMatchObject({ stateCode: "29", isDefaultShipping: true, phone: "+919876501234" });

    const bad = await c
      .post("/api/account/addresses")
      .send({ fullName: "X Y", phone: "9876501234", line1: "Somewhere", city: "Nowhere", state: "Atlantis", postalCode: "12" })
      .expect(400);
    expect(bad.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(["postalCode", "state"]);
  });

  it("cannot read another customer's address", async () => {
    const { client: a } = await loginAs(["CUSTOMER"]);
    const created = await a
      .post("/api/account/addresses")
      .send({ fullName: "Asha Rao", phone: "9876501234", line1: "12 MG Road", city: "Chennai", state: "Tamil Nadu", postalCode: "600001" })
      .expect(201);
    const { client: b } = await loginAs(["CUSTOMER"]);
    await b.delete(`/api/account/addresses/${created.body.data.id}`).expect(404);
  });
});
