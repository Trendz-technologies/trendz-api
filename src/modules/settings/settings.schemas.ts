import { z } from "zod";
import { aboutPageSchema, contactSchema, homePageSchema, privacyPageSchema, termsPageSchema } from "./cms";
import { homeOffersSchema } from "./home-offers";

/**
 * Typed business settings. Every rule that affects money, stock or tax and is
 * not fixed by law lives here so the business can change it without a deploy.
 * Defaults are placeholders that must be confirmed before go-live.
 */

const address = z.object({
  line1: z.string().max(200).default(""),
  line2: z.string().max(200).default(""),
  city: z.string().max(100).default(""),
  state: z.string().max(100).default(""),
  stateCode: z.string().regex(/^\d{2}$/, "2-digit GST state code").default("33"),
  postalCode: z.string().max(12).default(""),
  country: z.string().length(2).default("IN"),
});

// Stored lower-case so equal colours compare equal.
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour, e.g. #ff3d9a")
  .transform((v) => v.toLowerCase());

export const settingSchemas = {
  store: z.object({
    displayName: z.string().min(1).max(100).default("Trendz"),
    legalName: z.string().max(200).default("Trendz Retail Private Limited (placeholder)"),
    gstin: z.string().max(15).default(""),
    email: z.string().max(200).default("support@trendz.local"),
    phone: z.string().max(20).default(""),
    // address.stateCode is the seller's GST registration state; it decides
    // CGST+SGST (intra-state supply) vs IGST (inter-state supply).
    address: address.default(address.parse({})),
    currency: z.literal("INR").default("INR"),
  }),
  pricing: z.object({
    pricesIncludeTax: z.boolean().default(true),
    roundGrandTotal: z.boolean().default(false),
  }),
  shipping: z.object({
    mode: z.enum(["FLAT", "PROVIDER_RATES"]).default("FLAT"),
    flatRate: z.number().int().min(0).default(4900),
    freeShippingThreshold: z.number().int().min(0).nullable().default(99900),
    chargeTaxable: z.boolean().default(false),
    taxRateBps: z.number().int().min(0).max(10000).default(0),
    defaultWeightGrams: z.number().int().positive().default(500),
    defaultLengthCm: z.number().positive().default(25),
    defaultWidthCm: z.number().positive().default(20),
    defaultHeightCm: z.number().positive().default(5),
  }),
  checkout: z.object({
    reservationTtlMinutes: z.number().int().min(5).max(24 * 60).default(30),
    allowGuestCheckout: z.boolean().default(false),
    maxQuantityPerLine: z.number().int().min(1).max(1000).default(10),
  }),
  returns: z.object({
    windowDays: z.number().int().min(0).max(365).default(7),
    autoRestockGood: z.boolean().default(true),
  }),
  refunds: z.object({
    allowPartial: z.boolean().default(true),
  }),
  pos: z.object({
    maxManualDiscountBps: z.number().int().min(0).max(10000).default(1000),
    enabledPaymentMethods: z
      .array(z.enum(["CASH", "UPI_MANUAL", "CARD_MANUAL", "RAZORPAY"]))
      .default(["CASH", "UPI_MANUAL", "RAZORPAY"]),
  }),
  coupons: z.object({
    allowWithAutomaticDiscounts: z.boolean().default(true),
  }),
  invoice: z.object({
    // GST: invoice numbers ≤ 16 chars → prefix ≤ 4 (e.g. INV/2627/000123).
    prefix: z.string().regex(/^[A-Z0-9]{1,4}$/).default("INV"),
    creditNotePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/).default("CN"),
    footerNote: z.string().max(500).default("Thank you for shopping with us."),
    terms: z.string().max(2000).default("Goods once sold are subject to the store return policy."),
  }),
  barcodes: z.object({
    // 200-299 is the GS1 range reserved for in-store / restricted use.
    // Replace with your GS1 company prefix if you own one.
    ean13Prefix: z.string().regex(/^\d{3,10}$/).default("200"),
  }),
  inventory: z.object({
    defaultLowStockThreshold: z.number().int().min(0).default(5),
    lowStockAlertEmails: z.array(z.email()).default([]),
  }),
  notifications: z.object({
    emailEnabled: z.boolean().default(true),
    smsEnabled: z.boolean().default(true),
    adminEmails: z.array(z.email()).default([]),
  }),
  // Look and feel shared by the storefront, admin and POS. Presentation only:
  // the web app derives every other colour from these three values.
  appearance: z.object({
    mode: z.enum(["light", "dark"]).default("dark"),
    brandColor: hexColor.default("#ff3d9a"),
    // Optional override for body text; null derives it from the mode and brand.
    textColor: hexColor.nullable().default(null),
  }),
  // The offers block on the storefront home page. Content only.
  reviews: z.object({
    // Customers with a delivered order may rate and review its products. Off: reviews are neither taken nor shown.
    enabled: z.boolean().default(true),
    // true: a review appears on the product page only after staff publish it. false: it appears at once.
    requireApproval: z.boolean().default(true),
  }),
  homeOffers: homeOffersSchema,
  // Admin → CMS: the other home page sections, the contact details, the legal pages and the About us page. Content only.
  homePage: homePageSchema,
  contact: contactSchema,
  termsPage: termsPageSchema,
  privacyPage: privacyPageSchema,
  aboutPage: aboutPageSchema,
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type Settings = { [K in SettingKey]: z.infer<(typeof settingSchemas)[K]> };
export const SETTING_KEYS = Object.keys(settingSchemas) as SettingKey[];

/** Settings safe to expose to anonymous storefront visitors. */
export const PUBLIC_SETTING_KEYS = ["store", "pricing", "shipping", "checkout", "returns", "appearance", "homeOffers", "homePage", "contact", "termsPage", "privacyPage", "aboutPage"] as const;
