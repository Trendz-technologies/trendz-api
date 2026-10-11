import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { seedPermissions } from "../prisma/seed-core";
import { prisma } from "../src/database/prisma";
import { redis } from "../src/database/redis";
import { closeQueues } from "../src/jobs/queues";
import { systemContext } from "../src/modules/audit/audit.service";
import { getSetting, getSettings, SETTINGS_CACHE_KEY, updateSetting } from "../src/modules/settings/settings.service";
import { addAddress, makeProduct } from "./fixtures";
import { client, loginAs, resetDatabase } from "./helpers";

beforeEach(resetDatabase);
afterAll(closeQueues);

let n = 0;
const key = () => `rev-${Date.now()}-${++n}`;

type Made = Awaited<ReturnType<typeof makeProduct>>;

/** A new customer buys the product online and pays; the order is CONFIRMED, not yet delivered. */
async function buy(made: Made) {
  const { client: c, user } = await loginAs(["CUSTOMER"]);
  const address = await addAddress(c);
  await c.post("/api/cart/items").send({ variantId: made.variant.id, quantity: 1 }).expect(200);
  const order = (await c.post("/api/orders").set("Idempotency-Key", key()).send({ shippingAddressId: address.id }).expect(201)).body.data;
  const pay = (await c.post("/api/payments/create").set("Idempotency-Key", key()).send({ orderId: order.id }).expect(200)).body.data;
  const sim = (await c.post("/api/payments/mock/complete").send({ razorpayOrderId: pay.razorpayOrderId }).expect(200)).body.data;
  await c.post("/api/payments/verify").send(sim.checkoutResponse).expect(200);
  return { c, user, order: order as { id: string; orderNumber: string } };
}

const deliver = (orderId: string) => prisma.order.update({ where: { id: orderId }, data: { status: "DELIVERED", deliveredAt: new Date() } });

describe("writing a review", () => {
  it("is only for a customer whose order was delivered, and each customer has one review per product", async () => {
    const made = await makeProduct({ name: "Block Print Kurti", price: 129900, stock: 10 });
    const productId = made.product.id;
    const url = `/api/account/reviews/product/${productId}`;
    const { c, order } = await buy(made);

    // Paid but not delivered: not yet.
    expect((await c.get(url).expect(200)).body.data).toMatchObject({ enabled: true, canReview: false, review: null });
    const early = await c.put(url).send({ rating: 5 }).expect(403);
    expect(early.body.code).toBe("REVIEW_NOT_ELIGIBLE");
    expect((await c.get("/api/account/reviews").expect(200)).body.data.toReview).toEqual([]);

    await deliver(order.id);
    expect((await c.get(url).expect(200)).body.data.canReview).toBe(true);
    const waiting = (await c.get("/api/account/reviews").expect(200)).body.data.toReview;
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ orderNumber: order.orderNumber, product: { id: productId, name: "Block Print Kurti" } });

    // Stars are required and are 1 to 5; text is optional and trimmed.
    for (const rating of [0, 6, 4.5, "5"]) await c.put(url).send({ rating }).expect(400);
    const saved = (await c.put(url).send({ rating: 5, title: "  Lovely  ", comment: "Soft fabric, true to size." }).expect(200)).body.data;
    expect(saved).toMatchObject({ rating: 5, title: "Lovely", comment: "Soft fabric, true to size.", status: "PENDING", authorName: expect.stringMatching(/^Test U\.$/) });

    // Saving again edits the same review; it no longer waits in the "to review" list.
    const edited = (await c.put(url).send({ rating: 4, title: "", comment: "Colour is a shade lighter." }).expect(200)).body.data;
    expect(edited).toMatchObject({ id: saved.id, rating: 4, title: null, status: "PENDING" });
    expect(await prisma.productReview.count()).toBe(1);
    const mine = (await c.get("/api/account/reviews").expect(200)).body.data;
    expect(mine.toReview).toEqual([]);
    expect(mine.reviews).toHaveLength(1);
    expect(mine.reviews[0]).toMatchObject({ rating: 4, status: "PENDING", product: { id: productId } });

    // Someone who never received the product cannot review it, and neither can a visitor.
    const { client: stranger } = await loginAs(["CUSTOMER"]);
    await stranger.put(url).send({ rating: 1, comment: "Never bought it" }).expect(403);
    const anon = await client();
    await anon.put(url).send({ rating: 5 }).expect(401);

    // The customer can take their review back.
    await c.delete(url).expect(200);
    expect(await prisma.productReview.count()).toBe(0);
    await c.delete(url).expect(404);
  });
});

describe("moderation and the product page", () => {
  it("shows a review only after staff publish it, with the rating summary, and hides it again when rejected", async () => {
    const made = await makeProduct({ name: "Anarkali Set", price: 349900, stock: 10 });
    const reviewsUrl = `/api/store/products/${made.product.slug}/reviews`;
    const anon = await client();
    const first = await buy(made);
    const second = await buy(made);
    await deliver(first.order.id);
    await deliver(second.order.id);
    await first.c.put(`/api/account/reviews/product/${made.product.id}`).send({ rating: 4, title: "Good", comment: "Nice fall." }).expect(200);
    await second.c.put(`/api/account/reviews/product/${made.product.id}`).send({ rating: 5, comment: "Perfect for the function." }).expect(200);

    // Waiting for a moderator: the public sees nothing yet.
    expect((await anon.get(reviewsUrl).expect(200)).body.data).toMatchObject({ enabled: true, summary: { average: null, count: 0 }, items: [] });

    // Cashiers have no part in this.
    const { client: cashier } = await loginAs(["CASHIER"]);
    await cashier.get("/api/reviews").expect(403);

    const { client: manager, user: managerUser } = await loginAs(["MANAGER"]);
    const queue = await manager.get("/api/reviews?status=PENDING").expect(200);
    expect(queue.body.meta.counts).toEqual({ PENDING: 2, PUBLISHED: 0, REJECTED: 0 });
    expect(queue.body.data).toHaveLength(2);
    // Oldest first, with what a moderator needs to judge it.
    expect(queue.body.data[0]).toMatchObject({ rating: 4, status: "PENDING", product: { name: "Anarkali Set" }, customer: { id: first.user.id, email: first.user.email }, order: { orderNumber: first.order.orderNumber } });
    const [a, b] = queue.body.data as { id: string }[];
    await cashier.post(`/api/reviews/${a!.id}/moderate`).send({ action: "publish" }).expect(403);

    const published = (await manager.post(`/api/reviews/${a!.id}/moderate`).send({ action: "publish" }).expect(200)).body.data;
    expect(published.status).toBe("PUBLISHED");
    await manager.post(`/api/reviews/${b!.id}/moderate`).send({ action: "publish" }).expect(200);
    expect(await prisma.auditLog.count({ where: { action: "review.publish", userId: managerUser.id } })).toBe(2);
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: first.user.id, channel: "IN_APP", title: "Your review is live" } });
    expect(note.body).toContain("Anarkali Set");

    const page = (await anon.get(reviewsUrl).expect(200)).body;
    expect(page.data.summary).toEqual({ average: 4.5, count: 2, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } });
    expect(page.meta).toMatchObject({ total: 2, page: 1 });
    expect(page.data.items[0]).toMatchObject({ rating: 5, comment: "Perfect for the function.", authorName: expect.stringMatching(/^Test U\.$/) });
    // Nothing that identifies the customer leaves the API.
    expect(Object.keys(page.data.items[0]).sort()).toEqual(["authorName", "comment", "createdAt", "id", "rating", "title", "variantTitle"]);
    expect((await anon.get(`${reviewsUrl}?sort=lowest`).expect(200)).body.data.items[0].rating).toBe(4);
    await anon.get("/api/store/products/no-such-product/reviews").expect(404);

    // Rejecting takes it off the page; the customer is told and can try again, which sends it back to the queue.
    await manager.post(`/api/reviews/${a!.id}/moderate`).send({ action: "reject", note: "Mentions another shop" }).expect(200);
    expect((await anon.get(reviewsUrl).expect(200)).body.data.summary).toMatchObject({ average: 5, count: 1 });
    expect((await first.c.get("/api/account/reviews").expect(200)).body.data.reviews[0].status).toBe("REJECTED");
    expect(await prisma.notification.count({ where: { userId: first.user.id, title: "Your review was not published" } })).toBe(1);
    const again = (await first.c.put(`/api/account/reviews/product/${made.product.id}`).send({ rating: 4, comment: "Nice fall and finish." }).expect(200)).body.data;
    expect(again.status).toBe("PENDING");
    expect((await manager.get("/api/reviews?q=finish").expect(200)).body.data).toHaveLength(1);

    await manager.delete(`/api/reviews/${b!.id}`).expect(200);
    expect((await anon.get(reviewsUrl).expect(200)).body.data.summary.count).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "review.delete" } })).toBe(1);
  });

  it("follows the shop's settings: publish at once without approval, or switch reviews off altogether", async () => {
    const made = await makeProduct({ price: 99900, stock: 5 });
    const url = `/api/account/reviews/product/${made.product.id}`;
    const { c, order } = await buy(made);
    await deliver(order.id);
    const anon = await client();

    await updateSetting("reviews", { enabled: true, requireApproval: false }, systemContext);
    expect((await c.put(url).send({ rating: 3 }).expect(200)).body.data.status).toBe("PUBLISHED");
    expect((await anon.get(`/api/store/products/${made.product.slug}/reviews`).expect(200)).body.data.summary).toMatchObject({ average: 3, count: 1 });

    await updateSetting("reviews", { enabled: false, requireApproval: false }, systemContext);
    expect((await c.put(url).send({ rating: 5 }).expect(403)).body.code).toBe("REVIEWS_DISABLED");
    expect((await c.get(url).expect(200)).body.data).toMatchObject({ enabled: false, canReview: false });
    expect((await anon.get(`/api/store/products/${made.product.slug}/reviews`).expect(200)).body.data).toMatchObject({ enabled: false, summary: { count: 0 }, items: [] });
  });
});

describe("around the review", () => {
  it("invites the customer to review when the order is marked delivered", async () => {
    const made = await makeProduct({ price: 99900, stock: 5 });
    const { user, order } = await buy(made);
    const { client: admin } = await loginAs(["ADMIN"]);
    await admin.patch(`/api/orders/${order.id}/status`).send({ status: "DELIVERED" }).expect(200);

    const inApp = await prisma.notification.findFirstOrThrow({ where: { userId: user.id, channel: "IN_APP", title: `Order ${order.orderNumber} delivered` } });
    expect(inApp.body).toMatch(/rate and review/i);
    const email = await prisma.notification.findFirstOrThrow({ where: { userId: user.id, channel: "EMAIL", template: "order.delivered" } });
    expect((email.payload as { data: { reviewUrl: string } }).data.reviewUrl).toMatch(new RegExp(`/account/orders/${order.orderNumber}$`));
  });

  it("still has its settings right after a release, when the cached settings were written by the version before", async () => {
    // What the previous version left in the cache: every group except the new one.
    const { reviews: _added, ...older } = await getSettings();
    await redis.set(SETTINGS_CACHE_KEY, JSON.stringify(older), "EX", 300);

    expect(await getSetting("reviews")).toEqual({ enabled: true, requireApproval: true });
    const made = await makeProduct({ price: 99900, stock: 1 });
    const anon = await client();
    await redis.set(SETTINGS_CACHE_KEY, JSON.stringify(older), "EX", 300);
    expect((await anon.get(`/api/store/products/${made.product.slug}/reviews`).expect(200)).body.data.enabled).toBe(true);
  });

  it("gives a permission that is new to a database to the system roles that have it by default", async () => {
    // As on a shop that was set up before reviews existed: roles are there, the two permissions are not.
    await prisma.permission.deleteMany({ where: { code: { in: ["reviews.read", "reviews.moderate"] } } });
    const custom = await prisma.role.create({ data: { code: "STYLIST", name: "Stylist" } });
    const codes = async (role: string) => (await prisma.rolePermission.findMany({ where: { role: { code: role }, permission: { module: "reviews" } }, select: { permission: { select: { code: true } } } })).map((r) => r.permission.code).sort();
    expect(await codes("MANAGER")).toEqual([]);

    await seedPermissions(prisma);
    expect(await codes("MANAGER")).toEqual(["reviews.moderate", "reviews.read"]);
    expect(await codes("SUPPORT")).toEqual(["reviews.moderate", "reviews.read"]);
    expect(await codes("ADMIN")).toEqual(["reviews.moderate", "reviews.read"]);
    expect(await codes("CASHIER")).toEqual([]);
    expect(await prisma.rolePermission.count({ where: { roleId: custom.id } })).toBe(0);

    // Running the seed again grants nothing more (a shop may have taken the permission away on purpose).
    await prisma.rolePermission.deleteMany({ where: { role: { code: "SUPPORT" }, permission: { module: "reviews" } } });
    await seedPermissions(prisma);
    expect(await codes("SUPPORT")).toEqual([]);
  });
});
