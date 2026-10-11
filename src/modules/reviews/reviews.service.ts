import type { Prisma, ProductReview, ReviewStatus } from "@prisma/client";
import { z } from "zod";
import { forbidden, notFound } from "../../common/errors/app-error";
import { optionalText, pageArgs, pageMeta, type Pagination } from "../../common/utils/http";
import { prisma, withTransaction } from "../../database/prisma";
import { audit, type AuditContext } from "../audit/audit.service";
import { imageView } from "../media/image-view";
import { createNotification, dispatchNotifications } from "../notifications/notifications.service";
import { getSetting } from "../settings/settings.service";

/**
 * Customer reviews.
 *
 * - Only a customer with a delivered order for a product may review it, so
 *   every review is a verified purchase.
 * - One review per customer and product; saving again replaces it.
 * - Whether a review shows at once or waits for a moderator is a setting
 *   (`reviews.requireApproval`). An edited review is moderated again.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Plain text: trimmed, with an empty value stored as nothing. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters or fewer`)
    .nullable()
    .optional()
    .transform((v) => v || null);

export const reviewInputSchema = z.object({
  rating: z.number().int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars"),
  title: text(120),
  comment: text(2000),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const productSelect = {
  id: true,
  name: true,
  slug: true,
  status: true,
  images: { where: { url: { not: null } }, orderBy: { sortOrder: "asc" }, take: 1 },
} satisfies Prisma.ProductSelect;

type ProductBrief = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

const productView = (p: ProductBrief) => ({ id: p.id, name: p.name, slug: p.slug, available: p.status === "ACTIVE", image: p.images[0] ? imageView(p.images[0]) : null });

/** What anyone may see of a review. */
const publicView = (r: ProductReview) => ({
  id: r.id,
  rating: r.rating,
  title: r.title,
  comment: r.comment,
  authorName: r.authorName,
  variantTitle: r.variantTitle,
  createdAt: r.createdAt,
});

/** A customer's own review: also its moderation state. */
const ownView = (r: ProductReview) => ({ ...publicView(r), productId: r.productId, status: r.status, updatedAt: r.updatedAt });

/** "Asha R.": first name and the initial of the last name, never an email address or phone number. */
function displayName(profile: { firstName: string | null; lastName: string | null } | null): string {
  const first = profile?.firstName?.trim();
  const last = profile?.lastName?.trim();
  if (!first) return "Trendz customer";
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
}

// ---------------------------------------------------------------------------
// Who may review what
// ---------------------------------------------------------------------------

/** An order counts once it has been delivered, whatever happened to it afterwards (a return, a refund). */
const deliveredTo = (userId: string) => ({ userId, deliveredAt: { not: null }, status: { not: "CANCELLED" } }) satisfies Prisma.OrderWhereInput;

/** The customer's most recently delivered order line for the product, or null if they never received it. */
function deliveredPurchase(userId: string, productId: string) {
  return prisma.orderItem.findFirst({
    where: { productId, order: deliveredTo(userId) },
    orderBy: { order: { deliveredAt: "desc" } },
    select: { orderId: true, variantTitle: true },
  });
}

/** For the product page: may this customer write a review, and have they already? */
export async function reviewEligibility(userId: string, productId: string) {
  const [{ enabled }, purchase, review] = await Promise.all([
    getSetting("reviews"),
    deliveredPurchase(userId, productId),
    prisma.productReview.findUnique({ where: { userId_productId: { userId, productId } } }),
  ]);
  return { enabled, canReview: enabled && !!purchase, review: review ? ownView(review) : null };
}

// ---------------------------------------------------------------------------
// The customer's own reviews
// ---------------------------------------------------------------------------

export async function saveReview(userId: string, productId: string, input: ReviewInput) {
  const settings = await getSetting("reviews");
  if (!settings.enabled) throw forbidden("Reviews are closed at the moment", "REVIEWS_DISABLED");
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw notFound("Product");
  const purchase = await deliveredPurchase(userId, productId);
  if (!purchase) throw forbidden("You can review a product once your order for it has been delivered", "REVIEW_NOT_ELIGIBLE");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { profile: { select: { firstName: true, lastName: true } } } });
  const data = {
    ...input,
    authorName: displayName(user.profile),
    variantTitle: purchase.variantTitle,
    orderId: purchase.orderId,
    // A new or edited review goes (back) through moderation when the shop asks for it.
    status: (settings.requireApproval ? "PENDING" : "PUBLISHED") as ReviewStatus,
    moderatedById: null,
    moderatedAt: null,
    moderationNote: null,
  };
  const review = await prisma.productReview.upsert({ where: { userId_productId: { userId, productId } }, create: { userId, productId, ...data }, update: data });
  return ownView(review);
}

export async function deleteOwnReview(userId: string, productId: string) {
  const { count } = await prisma.productReview.deleteMany({ where: { userId, productId } });
  if (!count) throw notFound("Review");
}

/** The account's Reviews page: what the customer has written, and delivered products still waiting for a review. */
export async function accountReviews(userId: string) {
  const [{ enabled }, reviews, lines] = await Promise.all([
    getSetting("reviews"),
    prisma.productReview.findMany({ where: { userId }, orderBy: { updatedAt: "desc" }, include: { product: { select: productSelect } } }),
    prisma.orderItem.findMany({
      where: { order: deliveredTo(userId) },
      orderBy: { order: { deliveredAt: "desc" } },
      take: 200,
      select: { productId: true, variantTitle: true, order: { select: { orderNumber: true, deliveredAt: true } }, variant: { select: { product: { select: productSelect } } } },
    }),
  ]);

  const reviewed = new Set(reviews.map((r) => r.productId));
  const seen = new Set<string>();
  const toReview = [];
  for (const line of lines) {
    // One prompt per product (the latest delivery), and only for products still on sale.
    if (reviewed.has(line.productId) || seen.has(line.productId) || line.variant.product.status !== "ACTIVE") continue;
    seen.add(line.productId);
    toReview.push({ product: productView(line.variant.product), variantTitle: line.variantTitle, orderNumber: line.order.orderNumber, deliveredAt: line.order.deliveredAt });
  }

  return { enabled, reviews: reviews.map((r) => ({ ...ownView(r), product: productView(r.product) })), toReview: enabled ? toReview : [] };
}

// ---------------------------------------------------------------------------
// The product page (public)
// ---------------------------------------------------------------------------

export const reviewSortSchema = z.enum(["newest", "highest", "lowest"]).default("newest");

const SORTS: Record<z.infer<typeof reviewSortSchema>, Prisma.ProductReviewOrderByWithRelationInput[]> = {
  newest: [{ createdAt: "desc" }],
  highest: [{ rating: "desc" }, { createdAt: "desc" }],
  lowest: [{ rating: "asc" }, { createdAt: "desc" }],
};

/** Average (one decimal), number of reviews and how many gave each star, over published reviews only. */
export async function ratingSummary(productId: string) {
  const groups = await prisma.productReview.groupBy({ by: ["rating"], where: { productId, status: "PUBLISHED" }, _count: { _all: true } });
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let stars = 0;
  for (const g of groups) {
    distribution[g.rating as 1 | 2 | 3 | 4 | 5] = g._count._all;
    count += g._count._all;
    stars += g.rating * g._count._all;
  }
  return { average: count ? Math.round((stars / count) * 10) / 10 : null, count, distribution };
}

export async function publishedReviews(slug: string, sort: z.infer<typeof reviewSortSchema>, page: Pagination) {
  const product = await prisma.product.findFirst({ where: { slug, status: "ACTIVE" }, select: { id: true } });
  if (!product) throw notFound("Product");
  const { enabled } = await getSetting("reviews");
  // Switching reviews off hides them as well as closing them.
  if (!enabled) return { enabled, productId: product.id, summary: { average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } }, items: [], meta: pageMeta(page, 0) };

  const where = { productId: product.id, status: "PUBLISHED" } satisfies Prisma.ProductReviewWhereInput;
  const [summary, items] = await Promise.all([ratingSummary(product.id), prisma.productReview.findMany({ where, orderBy: SORTS[sort], ...pageArgs(page) })]);
  return { enabled, productId: product.id, summary, items: items.map(publicView), meta: pageMeta(page, summary.count) };
}

// ---------------------------------------------------------------------------
// Moderation (staff)
// ---------------------------------------------------------------------------

export const reviewListQuery = z.object({
  status: z.enum(["PENDING", "PUBLISHED", "REJECTED"]).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  productId: z.uuid().optional(),
  q: optionalText,
});

const staffInclude = {
  product: { select: productSelect },
  user: { select: { id: true, email: true, phone: true } },
  order: { select: { id: true, orderNumber: true, deliveredAt: true } },
} satisfies Prisma.ProductReviewInclude;

const staffView = (r: Prisma.ProductReviewGetPayload<{ include: typeof staffInclude }>) => ({
  ...publicView(r),
  status: r.status,
  updatedAt: r.updatedAt,
  moderatedAt: r.moderatedAt,
  moderationNote: r.moderationNote,
  product: productView(r.product),
  customer: r.user,
  order: r.order,
});

export async function listReviews(q: z.infer<typeof reviewListQuery>, page: Pagination) {
  const where: Prisma.ProductReviewWhereInput = {
    status: q.status,
    rating: q.rating,
    productId: q.productId,
    ...(q.q
      ? {
          OR: [
            { title: { contains: q.q, mode: "insensitive" } },
            { comment: { contains: q.q, mode: "insensitive" } },
            { authorName: { contains: q.q, mode: "insensitive" } },
            { product: { name: { contains: q.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const [total, rows, byStatus] = await Promise.all([
    prisma.productReview.count({ where }),
    // Oldest first while they wait, so nobody is left waiting; newest first otherwise.
    prisma.productReview.findMany({ where, include: staffInclude, orderBy: { createdAt: q.status === "PENDING" ? "asc" : "desc" }, ...pageArgs(page) }),
    prisma.productReview.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const counts: Record<ReviewStatus, number> = { PENDING: 0, PUBLISHED: 0, REJECTED: 0 };
  for (const g of byStatus) counts[g.status] = g._count._all;
  return { items: rows.map(staffView), meta: { ...pageMeta(page, total), counts } };
}

export const moderateSchema = z.object({
  action: z.enum(["publish", "reject"]),
  /** Internal note, e.g. why it was rejected. Never shown to the customer. */
  note: z.string().trim().max(500).nullable().optional(),
});

export async function moderateReview(id: string, input: z.infer<typeof moderateSchema>, ctx: AuditContext) {
  const before = await prisma.productReview.findUnique({ where: { id }, include: { product: { select: { name: true, slug: true } } } });
  if (!before) throw notFound("Review");
  const status: ReviewStatus = input.action === "publish" ? "PUBLISHED" : "REJECTED";

  const { review, notificationId } = await withTransaction(async (tx) => {
    const updated = await tx.productReview.update({
      where: { id },
      data: { status, moderatedById: ctx.userId, moderatedAt: new Date(), moderationNote: input.note || null },
      include: staffInclude,
    });
    await audit(tx, ctx, { action: `review.${input.action}`, entityType: "product_review", entityId: id, oldValue: { status: before.status }, newValue: { status, note: input.note || null } });
    // Tell the customer once per outcome (publishing the same review twice says nothing new).
    const notificationId =
      before.status === status
        ? null
        : await createNotification(tx, {
            channel: "IN_APP",
            userId: before.userId,
            title: status === "PUBLISHED" ? "Your review is live" : "Your review was not published",
            body:
              status === "PUBLISHED"
                ? `Thank you! Your review of ${before.product.name} is now on the product page.`
                : `Your review of ${before.product.name} could not be published. You can edit it and send it again.`,
            link: status === "PUBLISHED" ? `/products/${before.product.slug}` : "/account/reviews",
          });
    return { review: updated, notificationId };
  });
  await dispatchNotifications([notificationId]);
  return staffView(review);
}

export async function deleteReview(id: string, ctx: AuditContext) {
  const before = await prisma.productReview.findUnique({ where: { id } });
  if (!before) throw notFound("Review");
  await withTransaction(async (tx) => {
    await tx.productReview.delete({ where: { id } });
    await audit(tx, ctx, { action: "review.delete", entityType: "product_review", entityId: id, oldValue: { productId: before.productId, userId: before.userId, rating: before.rating, title: before.title, comment: before.comment, status: before.status } });
  });
}
