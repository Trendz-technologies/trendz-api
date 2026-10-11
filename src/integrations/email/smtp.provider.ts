import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env";
import type { EmailMessage, EmailProvider } from "./email.types";

/** Generic SMTP. Locally this delivers to the Mailpit container (http://localhost:8125). */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private transport: Transporter;

  constructor() {
    this.transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
  }

  async send(m: EmailMessage) {
    const info = await this.transport.sendMail({
      from: { name: env.EMAIL_FROM_NAME, address: env.EMAIL_FROM_ADDRESS },
      to: m.to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { messageId: info.messageId ?? null };
  }
}
