import { env } from "../../config/env";
import type { EmailMessage, EmailProvider } from "./email.types";

/** Brevo (Sendinblue) transactional email API v3. */
export class BrevoEmailProvider implements EmailProvider {
  readonly name = "brevo";

  constructor(private readonly apiKey: string) {}

  async send(m: EmailMessage) {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: env.EMAIL_FROM_NAME, email: env.EMAIL_FROM_ADDRESS },
        to: [{ email: m.to }],
        subject: m.subject,
        htmlContent: m.html,
        textContent: m.text,
        attachment: m.attachments?.map((a) => ({ name: a.filename, content: a.content.toString("base64") })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Brevo responded ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = (await res.json().catch(() => ({}))) as { messageId?: string };
    return { messageId: body.messageId ?? null };
  }
}
