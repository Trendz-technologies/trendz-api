import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../../config/env";
import type { EmailMessage, EmailProvider } from "./email.types";

/** Amazon SES v2, through nodemailer's SES transport (handles MIME + attachments). */
export class SesEmailProvider implements EmailProvider {
  readonly name = "ses";
  private transport: Transporter;

  constructor() {
    const sesClient = new SESv2Client({
      region: env.AWS_REGION,
      credentials:
        env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
          ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
          : undefined,
    });
    this.transport = nodemailer.createTransport({ SES: { sesClient, SendEmailCommand } });
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
