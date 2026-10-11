import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { ok, paginationQuery } from "../../common/utils/http";
import { INDIAN_STATES } from "../../common/utils/india";
import { publicBrands } from "../catalog/brands.routes";
import { publicTree } from "../catalog/categories.service";
import { notFound } from "../../common/errors/app-error";
import { isPageSlug, PAGE_SETTINGS, publishedPages, withAboutImage, withHomePictures } from "../settings/cms";
import { withImageUrls } from "../settings/home-offers";
import { getSettingRecord, getSettings } from "../settings/settings.service";
import * as store from "./storefront.service";
import { publicCoupons } from "../promotions/coupons.service";

/** Public, unauthenticated, cache-friendly catalog API for the storefront. */
export const storefrontRouter = Router();

const pageQuery = paginationQuery.extend({ limit: z.coerce.number().int().min(1).max(60).default(24) });

storefrontRouter.get("/config", async (_req, res) => {
  const s = await getSettings();
  // Checked with the server on every use (a cheap 304 when unchanged), so a saved
  // setting or theme is never served stale from a browser cache.
  res.setHeader("Cache-Control", "no-cache");
  ok(res, {
    store: { name: s.store.displayName, email: s.store.email, phone: s.store.phone, currency: s.store.currency },
    pricesIncludeTax: s.pricing.pricesIncludeTax,
    shipping: { mode: s.shipping.mode, flatRate: s.shipping.flatRate, freeShippingThreshold: s.shipping.freeShippingThreshold },
    returns: { windowDays: s.returns.windowDays },
    checkout: { allowGuestCheckout: s.checkout.allowGuestCheckout, maxQuantityPerLine: s.checkout.maxQuantityPerLine },
    payments: { provider: env.PAYMENT_PROVIDER, razorpayKeyId: env.PAYMENT_PROVIDER === "razorpay" ? env.RAZORPAY_KEY_ID : null },
    appearance: s.appearance,
    // Null while switched off, so unpublished offers are not readable from outside.
    homeOffers: s.homeOffers.enabled ? withImageUrls(s.homeOffers) : null,
    // Written in Admin → CMS. `pages` lists the legal pages that are published; their text is at /store/pages/:slug.
    home: withHomePictures(s.homePage),
    contact: s.contact,
    pages: publishedPages(s),
    // Whether the About us page is switched on, for the links to it; the page itself is at /store/about.
    aboutPublished: s.aboutPage.published,
    states: INDIAN_STATES,
  });
});

storefrontRouter.get("/about", async (_req, res) => {
  const { value, updatedAt } = await getSettingRecord("aboutPage");
  // A page that is switched off is not readable from outside.
  if (!value.published) throw notFound("Page");
  const { eyebrow, title, intro, body, imageUrl } = withAboutImage(value);
  res.setHeader("Cache-Control", "public, max-age=60");
  ok(res, { eyebrow, title, intro, body, imageUrl, updatedAt });
});

storefrontRouter.get("/pages/:slug", async (req, res) => {
  const { slug } = z.object({ slug: z.string().max(40) }).parse(req.params);
  if (!isPageSlug(slug)) throw notFound("Page");
  const { value: page, updatedAt } = await getSettingRecord(PAGE_SETTINGS[slug]);
  // A draft is not readable from outside.
  if (!page.published) throw notFound("Page");
  res.setHeader("Cache-Control", "public, max-age=60");
  ok(res, { slug, title: page.title, body: page.body, updatedAt });
});

storefrontRouter.get("/products", async (req, res) => {
  const q = store.listingQuery.parse(req.query);
  const { items, meta } = await store.listProducts(q, store.parseOptionFilters(req.query), pageQuery.parse(req.query));
  res.setHeader("Cache-Control", "public, max-age=30");
  ok(res, items, meta);
});

storefrontRouter.get("/products/facets", async (req, res) => {
  const q = store.listingQuery.parse(req.query);
  ok(res, await store.facets(q, store.parseOptionFilters(req.query)));
});

storefrontRouter.get("/products/:slug", async (req, res) => {
  const { slug } = z.object({ slug: z.string().max(120) }).parse(req.params);
  ok(res, await store.productDetail(slug));
});

storefrontRouter.get("/search/suggest", async (req, res) => {
  const { q } = z.object({ q: z.string().trim().min(2).max(60) }).parse(req.query);
  ok(res, await store.suggest(q));
});

storefrontRouter.get("/categories", async (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=120");
  ok(res, await publicTree());
});

storefrontRouter.get("/categories/:slug", async (req, res) => {
  ok(res, await store.categoryDetail(z.object({ slug: z.string().max(120) }).parse(req.params).slug));
});

storefrontRouter.get("/brands", async (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=120");
  ok(res, await publicBrands());
});

storefrontRouter.get("/coupons", async (_req, res) => ok(res, await publicCoupons()));

storefrontRouter.get("/sitemap", async (_req, res) => ok(res, await store.sitemapEntries()));
