import { z } from "zod";
import { contentImageKey, contentImageUrl as imageUrl, localizedText as text, siteLink } from "./content";

/**
 * The offers block on the storefront home page (Admin → Home page offers).
 *
 * Content only: nothing here changes a price or applies a discount. Every
 * piece of text is kept in English and Tamil; the storefront shows the
 * shopper's language and falls back to the other one when it is empty.
 *
 * The defaults are the shop's grand-opening flyer, so the block has something
 * real in it until the shop writes its own.
 */
export const MAX_OFFER_CARDS = 4;

const link = siteLink();

const day = z.iso.date("Use a date like 2026-10-12").nullable();

const card = z.object({
  // Small ribbon above the title ("Opening offer").
  tag: text(40).default({ en: "", ta: "" }),
  title: text(60).default({ en: "", ta: "" }),
  // Line between the title and the price ("4 tops for").
  caption: text(80).default({ en: "", ta: "" }),
  // Paise, shown as a rupee amount; null shows no price.
  price: z.number().int().min(0).max(100_000_000).nullable().default(null),
  href: link,
  imageKey: contentImageKey,
});

export const homeOffersSchema = z
  .object({
    enabled: z.boolean().default(true),
    eyebrow: text(40).default({ en: "Grand opening", ta: "திறப்பு விழா" }),
    title: text(80).default({ en: "Opening offers", ta: "திறப்பு விழா சலுகைகள்" }),
    subtitle: text(200).default({ en: "You are warmly invited to our grand opening.", ta: "எங்கள் திறப்பு விழாவிற்கு உங்களை அன்புடன் அழைக்கிறோம்." }),
    // The offer period (India dates). It is printed on the sale banner, and the whole
    // block leaves the home page the day after `endsOn`.
    startsOn: day.default("2026-10-12"),
    endsOn: day.default("2026-10-19"),
    cards: z
      .array(card)
      .max(MAX_OFFER_CARDS)
      .default([
        { tag: { en: "Opening offer", ta: "திறப்பு சலுகை" }, title: { en: "Short Top", ta: "ஷார்ட் டாப்" }, caption: { en: "4 tops for", ta: "4 டாப்கள்" }, price: 89_900, href: "", imageKey: null },
        { tag: { en: "Opening offer", ta: "திறப்பு சலுகை" }, title: { en: "Open Top", ta: "ஓபன் டாப்" }, caption: { en: "4 tops for", ta: "4 டாப்கள்" }, price: 89_900, href: "", imageKey: null },
      ]),
    gift: z
      .object({
        enabled: z.boolean().default(true),
        text: text(200).default({ en: "", ta: "" }),
        tag: text(40).default({ en: "", ta: "" }),
      })
      .default({
        enabled: true,
        text: {
          en: "To celebrate our opening, 100 customers who buy a dress get special gifts free!",
          ta: "திறப்பு விழாவை முன்னிட்டு டிரஸ் வாங்கும் 100 வாடிக்கையாளர்களுக்கு சிறப்பு பரிசுகள் இலவசம்!",
        },
        tag: { en: "Special gifts free", ta: "சிறப்பு பரிசுகள் இலவசம்" },
      }),
    sale: z
      .object({
        enabled: z.boolean().default(true),
        label: text(60).default({ en: "", ta: "" }),
        // The big figure ("20%") and the word under it ("off").
        value: z.string().trim().max(10).default(""),
        valueLabel: text(20).default({ en: "", ta: "" }),
        href: link,
      })
      .default({
        enabled: true,
        label: { en: "Grand opening special", ta: "திறப்பு விழா சிறப்பு சலுகை" },
        value: "20%",
        valueLabel: { en: "off", ta: "தள்ளுபடி" },
        href: "",
      }),
  })
  .refine((v) => !v.startsOn || !v.endsOn || v.startsOn <= v.endsOn, { path: ["endsOn"], message: "The end date is before the start date" });

export type HomeOffers = z.infer<typeof homeOffersSchema>;

/** The stored block with each card's image address worked out from its storage key. */
export const withImageUrls = (offers: HomeOffers) => ({ ...offers, cards: offers.cards.map((c) => ({ ...c, imageUrl: imageUrl(c.imageKey) })) });
