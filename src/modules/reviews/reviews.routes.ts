import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../common/guards/permissions";
import { authenticate, requireStaff } from "../../common/middleware/authenticate";
import { rateLimit } from "../../common/middleware/rate-limit";
import { ok, paginationQuery, uuidParam } from "../../common/utils/http";
import { auditContext } from "../audit/audit.service";
import * as reviews from "./reviews.service";

const productParam = z.object({ productId: z.uuid() });

/** Public: /api/store/products/:slug/reviews */
export const storeReviewsRouter = Router();

storeReviewsRouter.get("/products/:slug/reviews", async (req, res) => {
  const { slug } = z.object({ slug: z.string().max(120) }).parse(req.params);
  const { sort } = z.object({ sort: reviews.reviewSortSchema }).parse(req.query);
  const page = paginationQuery.extend({ limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
  const { items, meta, ...rest } = await reviews.publishedReviews(slug, sort, page);
  res.setHeader("Cache-Control", "public, max-age=30");
  ok(res, { ...rest, items }, meta);
});

/** The signed-in customer: /api/account/reviews */
export const accountReviewsRouter = Router();
accountReviewsRouter.use(authenticate);

// A customer writes a handful of reviews, not hundreds: 30 saves an hour is generous.
const writeLimit = rateLimit({ name: "review-write", points: 30, durationSeconds: 3600, key: (req) => req.auth?.userId ?? null, message: "You are saving reviews too quickly. Please try again later." });

accountReviewsRouter.get("/reviews", async (req, res) => ok(res, await reviews.accountReviews(req.auth!.userId)));

accountReviewsRouter.get("/reviews/product/:productId", async (req, res) => {
  ok(res, await reviews.reviewEligibility(req.auth!.userId, productParam.parse(req.params).productId));
});

accountReviewsRouter.put("/reviews/product/:productId", writeLimit, async (req, res) => {
  ok(res, await reviews.saveReview(req.auth!.userId, productParam.parse(req.params).productId, reviews.reviewInputSchema.parse(req.body)));
});

accountReviewsRouter.delete("/reviews/product/:productId", async (req, res) => {
  await reviews.deleteOwnReview(req.auth!.userId, productParam.parse(req.params).productId);
  ok(res, { deleted: true });
});

/** Staff moderation: /api/reviews */
export const reviewsRouter = Router();
reviewsRouter.use(authenticate, requireStaff);

reviewsRouter.get("/", requirePermission("reviews.read"), async (req, res) => {
  const { items, meta } = await reviews.listReviews(reviews.reviewListQuery.parse(req.query), paginationQuery.parse(req.query));
  ok(res, items, meta);
});

reviewsRouter.post("/:id/moderate", requirePermission("reviews.moderate"), async (req, res) => {
  ok(res, await reviews.moderateReview(uuidParam.parse(req.params).id, reviews.moderateSchema.parse(req.body), auditContext(req)));
});

reviewsRouter.delete("/:id", requirePermission("reviews.moderate"), async (req, res) => {
  await reviews.deleteReview(uuidParam.parse(req.params).id, auditContext(req));
  ok(res, { deleted: true });
});
