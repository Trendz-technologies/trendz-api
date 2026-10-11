import { env } from "../../config/env";
import { BrevoEmailProvider } from "./brevo.provider";
import type { EmailProvider } from "./email.types";
import { SesEmailProvider } from "./ses.provider";
import { SmtpEmailProvider } from "./smtp.provider";

let provider: EmailProvider | null = null;

/** The configured email provider. Business code depends only on EmailProvider. */
export function emailProvider(): EmailProvider {
  if (provider) return provider;
  switch (env.EMAIL_PROVIDER) {
    case "brevo":
      if (!env.EMAIL_API_KEY) throw new Error("EMAIL_PROVIDER=brevo requires EMAIL_API_KEY");
      provider = new BrevoEmailProvider(env.EMAIL_API_KEY);
      break;
    case "ses":
      provider = new SesEmailProvider();
      break;
    default:
      provider = new SmtpEmailProvider();
  }
  return provider;
}

export type { EmailProvider, EmailMessage, EmailAttachment } from "./email.types";
