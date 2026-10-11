import { z } from "zod";
import { richTextToPlain, sanitizeRichText } from "../../common/utils/html";
import { contentImageKey, contentImageUrl, localizedText, siteLink } from "./content";

/**
 * Storefront content written under Admin → CMS: the sections of the home
 * page, the contact page, the legal pages (terms, privacy) and the About us page.
 *
 * Content only: nothing here changes a price, a tax or a stock rule. Text is
 * kept in English and Tamil; the storefront shows the shopper's language and
 * falls back to the other one when it is empty. The defaults are the text the
 * storefront had before it became editable, so nothing changes until the shop
 * rewrites it.
 */

const words = (max: number, en: string, ta: string) => localizedText(max).default({ en, ta });
const shown = z.boolean().default(true);

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------

export const MAX_EDITORIAL_POINTS = 3;

/** A product section: small heading, heading and the link beside them. */
const listing = (eyebrow: [string, string], title: [string, string], linkLabel: [string, string]) =>
  z.object({ enabled: shown, eyebrow: words(40, ...eyebrow), title: words(80, ...title), linkLabel: words(40, ...linkLabel) }).prefault({});

export const homePageSchema = z.object({
  // The shop's logo, uploaded here and shown on every storefront page (header, footer) and in the
  // closing band below; null keeps the logo that ships with the application.
  logo: z.object({ imageKey: contentImageKey }).prefault({}),
  // The banner at the top. Always shown.
  hero: z
    .object({
      // The headline is two lines: the first in gold, the second in the brand colour.
      titleTop: words(40, "Luxury in", "ஒவ்வொரு தையலிலும்"),
      titleBottom: words(40, "Every Stitch.", "ஆடம்பரம்."),
      tagline: words(60, "Fashion for every you", "உங்கள் ஒவ்வொரு தருணத்திற்கும் ஃபேஷன்"),
      body: words(
        300,
        "Kurti sets, anarkalis, lehengas, party wear and more — thoughtfully chosen pieces for every celebration and every day.",
        "குர்தி செட்கள், அனார்கலிகள், லெஹங்காக்கள், பார்ட்டி உடைகள் மற்றும் பல — ஒவ்வொரு கொண்டாட்டத்திற்கும் ஒவ்வொரு நாளுக்கும் கவனமாகத் தேர்ந்தெடுத்த ஆடைகள்.",
      ),
      primaryLabel: words(40, "Explore collection", "தொகுப்பைப் பாருங்கள்"),
      primaryHref: siteLink("/products"),
      secondaryLabel: words(40, "See today's offers", "இன்றைய சலுகைகளைப் பாருங்கள்"),
      secondaryHref: siteLink("/offers"),
      // The first of the three figures under the buttons. The other two state the
      // free-shipping amount and the return window, so they come from those settings.
      highlightValue: words(20, "Weekly", "வாரந்தோறும்"),
      highlightLabel: words(30, "New arrivals", "புதிய வரவுகள்"),
      // Picture in the arched frame; null shows the first featured product.
      imageKey: contentImageKey,
    })
    .refine((hero) => [hero.titleTop, hero.titleBottom].some((line) => line.en !== "" || line.ta !== ""), { path: ["titleTop"], message: "The banner needs a headline" })
    .prefault({}),
  categories: listing(["Collections", "தொகுப்புகள்"], ["Shop by category", "வகை வாரியாக வாங்குங்கள்"], ["Browse everything", "அனைத்தையும் பாருங்கள்"]),
  popular: listing(["Most loved", "அதிகம் விரும்பப்பட்டவை"], ["Popular picks", "பிரபலமான தேர்வுகள்"], ["View all", "அனைத்தையும் காண்க"]),
  // The wide card with a product photo beside a short piece about the shop.
  editorial: z
    .object({
      enabled: shown,
      eyebrow: words(40, "The Trendz edit", "Trendz தேர்வு"),
      // The heading is two lines; the second is in the brand colour.
      title: words(80, "Made for every occasion.", "ஒவ்வொரு நிகழ்விற்கும் ஏற்றது."),
      titleAccent: words(80, "Styled your way.", "உங்கள் பாணியில்."),
      body: words(
        400,
        "Graceful silhouettes, rich fabrics and colours that flatter — so every piece you pick feels special, whether it is a festival, a function or an ordinary day.",
        "நேர்த்தியான வடிவங்கள், செழுமையான துணிகள், அழகூட்டும் நிறங்கள் — பண்டிகையோ, விசேஷமோ, சாதாரண நாளோ, நீங்கள் தேர்ந்தெடுக்கும் ஒவ்வொரு ஆடையும் சிறப்பாக இருக்கும்.",
      ),
      points: z
        .array(localizedText(40))
        .max(MAX_EDITORIAL_POINTS)
        .default([
          { en: "Festive edits", ta: "பண்டிகைத் தேர்வுகள்" },
          { en: "Everyday elegance", ta: "அன்றாட நேர்த்தி" },
          { en: "Perfect fits", ta: "கச்சிதமான பொருத்தம்" },
        ]),
    })
    .prefault({}),
  // Delivery, returns and payment. The delivery and returns headings state the
  // store's own rules, so the storefront builds them from the shipping and returns
  // settings; only the lines under them are written here.
  promises: z
    .object({
      enabled: shown,
      shippingBody: words(200, "Every order ships with live tracking updates by SMS and email.", "ஒவ்வொரு ஆர்டரின் நிலையும் SMS மற்றும் மின்னஞ்சல் மூலம் உடனுக்குடன் தெரிவிக்கப்படும்."),
      returnsBody: words(200, "Changed your mind? Request a return from your account in a few taps.", "மனம் மாறிவிட்டதா? உங்கள் கணக்கிலிருந்து சில தட்டல்களில் ரிட்டர்ன் கோருங்கள்."),
      paymentTitle: words(60, "Secure checkout", "பாதுகாப்பான செக்அவுட்"),
      paymentBody: words(200, "Pay with UPI, cards or netbanking through Razorpay.", "Razorpay மூலம் UPI, கார்டு அல்லது நெட்பேங்கிங்கில் பணம் செலுத்துங்கள்."),
    })
    .prefault({}),
  newArrivals: listing(["Just landed", "புதிதாக வந்தவை"], ["New arrivals", "புதிய வரவுகள்"], ["Shop new", "புதியவற்றைப் பாருங்கள்"]),
  // The dark band with the logo at the foot of the page.
  closing: z
    .object({
      enabled: shown,
      title: words(120, "Find the outfit that feels like you.", "உங்களுக்கே உரிய ஆடையைக் கண்டறியுங்கள்."),
      buttonLabel: words(40, "Shop the collection", "தொகுப்பை வாங்குங்கள்"),
      buttonHref: siteLink("/products"),
      // Opens a chat with the WhatsApp number on the contact page; empty hides the button.
      whatsappLabel: words(40, "Chat on WhatsApp", "WhatsApp-ல் பேசுங்கள்"),
    })
    .prefault({}),
});

export type HomePage = z.infer<typeof homePageSchema>;

/** The stored home page with the addresses of its pictures (the logo and the banner picture) worked out from their storage keys. */
export const withHomePictures = (home: HomePage) => ({
  ...home,
  logo: { ...home.logo, imageUrl: contentImageUrl(home.logo.imageKey) },
  hero: { ...home.hero, imageUrl: contentImageUrl(home.hero.imageKey) },
});

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

// As it is printed, spaces included; the storefront builds the tel: and wa.me links from the digits.
const phone = z
  .string()
  .trim()
  .regex(/^(\+?\d[\d\s-]{5,18}\d)?$/, "Use digits with the country code, e.g. +91 93607 34597");

const isHttpsUrl = (value: string) => URL.canParse(value) && new URL(value).protocol === "https:";

/**
 * How shoppers reach the shop: shown on the contact page and in the footer of
 * every page. Separate from the `store` setting, which is the seller's legal
 * identity printed on invoices.
 */
export const contactSchema = z.object({
  eyebrow: words(40, "Get in touch", "தொடர்பு கொள்ளுங்கள்"),
  title: words(80, "Contact us", "எங்களைத் தொடர்பு கொள்ளுங்கள்"),
  intro: words(
    400,
    "Questions about an order, a size or a style? Message us on WhatsApp, call the shop or visit us. We are happy to help.",
    "ஆர்டர், அளவு அல்லது ஸ்டைல் பற்றி ஏதேனும் கேள்வி உள்ளதா? WhatsApp-ல் செய்தி அனுப்புங்கள், கடைக்கு அழையுங்கள் அல்லது நேரில் வாருங்கள். உதவ நாங்கள் தயாராக இருக்கிறோம்.",
  ),
  phone: phone.default("+91 93607 34597"),
  whatsapp: phone.default("+91 93607 34597"),
  email: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address")
    .default(""),
  instagram: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._]{0,30}$/, "Only the handle, without @ or a link")
    .default("trendz_womenswear_"),
  // One line of the address per line of text.
  address: words(300, "Shop No. 724, Uthukuli Road\nKunnathur – 638 103", "கடை எண் 724, ஊத்துக்குளி ரோடு\nகுன்னத்தூர் – 638 103"),
  // Opening hours, one line per line of text. Empty until the shop fills them in.
  hours: localizedText(300).default({ en: "", ta: "" }),
  // "Get directions" link, e.g. the shop's Google Maps address.
  mapUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || isHttpsUrl(v), "Use a full link that starts with https://")
    .default(""),
});

export type Contact = z.infer<typeof contactSchema>;

// ---------------------------------------------------------------------------
// Legal pages
// ---------------------------------------------------------------------------

export const MAX_PAGE_CHARS = 40_000;

// Typed in the rich text editor: stored as allow-listed HTML and limited by the length of its text, not of its markup.
const richText = (fallback = "") =>
  z
    .string()
    .max(MAX_PAGE_CHARS * 8 + 500)
    .default(fallback)
    .transform((html) => sanitizeRichText(html) ?? "")
    .refine((html) => (richTextToPlain(html)?.length ?? 0) <= MAX_PAGE_CHARS, `Keep the page to ${MAX_PAGE_CHARS.toLocaleString("en-IN")} characters or fewer`);
const pageBody = richText();

/**
 * A page of the shop's own wording. It starts empty and unpublished: the
 * storefront links to it only once it is published.
 */
const legalPage = (en: string, ta: string) =>
  z
    .object({
      published: z.boolean().default(false),
      title: words(80, en, ta),
      body: z.object({ en: pageBody, ta: pageBody }).prefault({}),
    })
    .refine((page) => !page.published || page.body.en !== "" || page.body.ta !== "", { path: ["published"], message: "Write the page before publishing it" });

export const termsPageSchema = legalPage("Terms & Conditions", "விதிமுறைகள் மற்றும் நிபந்தனைகள்");
export const privacyPageSchema = legalPage("Privacy Policy", "தனியுரிமைக் கொள்கை");

export type LegalPage = z.infer<typeof termsPageSchema>;

/** Storefront address of each legal page (/terms, /privacy) → the setting that holds it. */
export const PAGE_SETTINGS = { terms: "termsPage", privacy: "privacyPage" } as const;
export type PageSlug = keyof typeof PAGE_SETTINGS;
export const PAGE_SLUGS = Object.keys(PAGE_SETTINGS) as PageSlug[];
export const isPageSlug = (slug: string): slug is PageSlug => Object.hasOwn(PAGE_SETTINGS, slug);

/** The pages the storefront may link to, with their titles (the text itself is fetched per page). */
export const publishedPages = (settings: Record<(typeof PAGE_SETTINGS)[PageSlug], LegalPage>) =>
  PAGE_SLUGS.filter((slug) => settings[PAGE_SETTINGS[slug]].published).map((slug) => ({ slug, title: settings[PAGE_SETTINGS[slug]].title }));

// ---------------------------------------------------------------------------
// About us
// ---------------------------------------------------------------------------

// Starting text for the page, in the rich text editor's own markup. It says only
// what the storefront already says elsewhere (the collections, weekly arrivals,
// WhatsApp help, the shop and home delivery); the shop's history is for the shop to add.
const ABOUT_BODY = {
  en: [
    "<h3>Luxury in every stitch</h3>",
    "<p>Trendz Women's Wear is a boutique for women and girls who love to dress well. We choose every piece for its fabric, its fit and its finish, so that what you take home looks beautiful and feels comfortable all day.</p>",
    "<h3>What you will find</h3>",
    "<ul>",
    "<li>Kurti sets for work, college and every day</li>",
    "<li>Anarkalis and lehengas for weddings, festivals and functions</li>",
    "<li>Western wear and party wear for outings and evenings</li>",
    "<li>Kids wear for the little ones</li>",
    "</ul>",
    "<h3>Fashion for every you</h3>",
    "<p>New styles arrive every week, so there is always something fresh to see. Not sure about a size or a colour? Message us on WhatsApp and we will help you choose.</p>",
    "<h3>Shop the way you like</h3>",
    "<p>Visit the shop to see the collection in person, or order here on the website and have it delivered to your door.</p>",
  ].join(""),
  ta: [
    "<h3>ஒவ்வொரு தையலிலும் ஆடம்பரம்</h3>",
    "<p>Trendz Women's Wear, அழகாக உடுத்த விரும்பும் பெண்களுக்கும் சிறுமிகளுக்கும் ஆன ஆடையகம். ஒவ்வொரு ஆடையையும் அதன் துணி, பொருத்தம் மற்றும் நேர்த்தியைப் பார்த்துத் தேர்ந்தெடுக்கிறோம்; அதனால் நீங்கள் வாங்கும் ஆடை அழகாகவும் நாள் முழுவதும் வசதியாகவும் இருக்கும்.</p>",
    "<h3>இங்கே என்ன கிடைக்கும்</h3>",
    "<ul>",
    "<li>அலுவலகம், கல்லூரி மற்றும் அன்றாடப் பயன்பாட்டிற்கான குர்தி செட்கள்</li>",
    "<li>திருமணம், பண்டிகை மற்றும் விசேஷங்களுக்கான அனார்கலிகள் மற்றும் லெஹங்காக்கள்</li>",
    "<li>வெளியே செல்வதற்கும் மாலை நேர நிகழ்வுகளுக்கும் வெஸ்டர்ன் உடைகள் மற்றும் பார்ட்டி உடைகள்</li>",
    "<li>குழந்தைகளுக்கான உடைகள்</li>",
    "</ul>",
    "<h3>உங்கள் ஒவ்வொரு தருணத்திற்கும் ஃபேஷன்</h3>",
    "<p>ஒவ்வொரு வாரமும் புதிய டிசைன்கள் வருகின்றன; பார்க்க எப்போதும் புதிதாக ஏதாவது இருக்கும். அளவு அல்லது நிறம் பற்றி சந்தேகமா? WhatsApp-ல் செய்தி அனுப்புங்கள், தேர்ந்தெடுக்க உதவுகிறோம்.</p>",
    "<h3>உங்களுக்கு வசதியான முறையில் வாங்குங்கள்</h3>",
    "<p>கடைக்கு நேரில் வந்து தொகுப்பைப் பாருங்கள், அல்லது இந்த இணையதளத்தில் ஆர்டர் செய்து வீட்டிலேயே பெற்றுக்கொள்ளுங்கள்.</p>",
  ].join(""),
};

/**
 * The About us page, at /about. Unlike the legal pages it starts written and
 * published, so the header and footer can link to it from the first day.
 * Switched off, the page is not served and the links to it are left out.
 */
export const aboutPageSchema = z
  .object({
    published: z.boolean().default(true),
    eyebrow: words(40, "Our story", "எங்கள் கதை"),
    title: words(80, "About Trendz", "Trendz பற்றி"),
    // The few lines beside the heading in the banner at the top of the page.
    intro: words(
      400,
      "A boutique in Kunnathur for women and girls: kurti sets, anarkalis, lehengas, western wear, party wear and kids wear, chosen with care for every celebration and every day.",
      "குன்னத்தூரில் பெண்களுக்கும் சிறுமிகளுக்கும் ஆன ஆடையகம்: குர்தி செட்கள், அனார்கலிகள், லெஹங்காக்கள், வெஸ்டர்ன் உடைகள், பார்ட்டி உடைகள் மற்றும் குழந்தைகள் உடைகள் — ஒவ்வொரு கொண்டாட்டத்திற்கும் ஒவ்வொரு நாளுக்கும் கவனமாகத் தேர்ந்தெடுத்தவை.",
    ),
    // Picture in the banner; null shows the shop's logo.
    imageKey: contentImageKey,
    body: z.object({ en: richText(ABOUT_BODY.en), ta: richText(ABOUT_BODY.ta) }).prefault({}),
  })
  .refine((page) => !page.published || page.body.en !== "" || page.body.ta !== "", { path: ["published"], message: "Write the page before publishing it" });

export type AboutPage = z.infer<typeof aboutPageSchema>;

/** The stored About us page with its picture's address worked out from its storage key. */
export const withAboutImage = (about: AboutPage) => ({ ...about, imageUrl: contentImageUrl(about.imageKey) });
