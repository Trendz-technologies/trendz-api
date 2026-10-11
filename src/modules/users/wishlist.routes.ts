import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../database/prisma";
import { authenticate } from "../../common/middleware/authenticate";
import { badRequest } from "../../common/errors/app-error";
import { created, ok } from "../../common/utils/http";
import { imageView } from "../media/image-view";

/** /api/account/wishlist */
export const wishlistRouter = Router();
wishlistRouter.use(authenticate);

const MAX_ITEMS = 200;

wishlistRouter.get("/wishlist", async (req, res) => {
  const items = await prisma.wishlistItem.findMany({
    where: { userId: req.auth!.userId },
    orderBy: { createdAt: "desc" },
    include: {
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          mrp: true,
          sellingPrice: true,
          images: { where: { url: { not: null } }, orderBy: { sortOrder: "asc" }, take: 1 },
        },
      },
    },
  });
  ok(
    res,
    items.map((i) => ({
      productId: i.productId,
      addedAt: i.createdAt,
      name: i.product.name,
      slug: i.product.slug,
      available: i.product.status === "ACTIVE",
      mrp: i.product.mrp,
      sellingPrice: i.product.sellingPrice,
      image: i.product.images[0] ? imageView(i.product.images[0]) : null,
    })),
  );
});

wishlistRouter.post("/wishlist", async (req, res) => {
  const { productId } = z.object({ productId: z.uuid() }).parse(req.body);
  const product = await prisma.product.findFirst({ where: { id: productId, status: "ACTIVE" }, select: { id: true } });
  if (!product) throw badRequest("This product is not available");
  if ((await prisma.wishlistItem.count({ where: { userId: req.auth!.userId } })) >= MAX_ITEMS) throw badRequest(`Your wishlist can hold up to ${MAX_ITEMS} items`);
  await prisma.wishlistItem.upsert({
    where: { userId_productId: { userId: req.auth!.userId, productId } },
    create: { userId: req.auth!.userId, productId },
    update: {},
  });
  created(res, { productId, saved: true });
});

wishlistRouter.delete("/wishlist/:productId", async (req, res) => {
  const { productId } = z.object({ productId: z.uuid() }).parse(req.params);
  await prisma.wishlistItem.deleteMany({ where: { userId: req.auth!.userId, productId } });
  ok(res, { productId, saved: false });
});
