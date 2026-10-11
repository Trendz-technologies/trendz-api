import sanitizeHtml from "sanitize-html";
import { z } from "zod";

/**
 * Allow-list for rich text typed in the admin (descriptions). Everything else
 * (scripts, styles, event handlers, iframes, images, inline CSS, classes,
 * javascript: URLs) is removed before the HTML is stored, so every screen that
 * shows it only ever renders safe markup.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "h3", "h4", "blockquote", "a", "span"],
  allowedAttributes: { a: ["href", "title", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow" }),
  },
  disallowedTagsMode: "discard",
};

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

/** The words of a rich-text value, for places that need plain text (meta descriptions, length limits). */
export function richTextToPlain(html: string | null | undefined): string | null {
  if (html == null) return null;
  // A space where a block ends, so "<p>One</p><p>Two</p>" reads "One Two".
  const spaced = html.replace(/<\/(p|li|h[1-6]|blockquote|div)>|<br\s*\/?>/gi, "$& ");
  const text = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity]!)
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text;
}

/** Sanitised HTML, or null when nothing readable is left (an editor's empty "<p><br></p>" included). */
export function sanitizeRichText(html: string | null | undefined): string | null {
  if (html == null) return null;
  const clean = sanitizeHtml(html, OPTIONS).trim();
  return clean === "" || richTextToPlain(clean) === null ? null : clean;
}

/**
 * Schema for a description typed in the admin's rich text editor: stored as
 * sanitised HTML, and limited by the length of its text, not of its markup.
 */
export const richText = (maxChars: number) =>
  z
    .string()
    // Generous room for tags around the text; the real limit is the refine below.
    .max(maxChars * 8 + 500)
    .transform((html) => sanitizeRichText(html))
    .refine((html) => (richTextToPlain(html)?.length ?? 0) <= maxChars, `Keep this to ${maxChars} characters or fewer`)
    .nullable()
    .optional();
