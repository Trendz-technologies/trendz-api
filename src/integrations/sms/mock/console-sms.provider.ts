import { logger } from "../../../config/logger";
import type { SmsMessage, SmsProvider } from "../sms.types";

/**
 * DEVELOPMENT ONLY. Writes SMS messages to the API log instead of sending
 * them, so OTP login can be tested without an SMS account. Refused in
 * production by config/env.ts.
 */
export class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console";

  async send(m: SmsMessage) {
    logger.info({ to: m.to, template: m.template }, `[DEV SMS] ${m.text}`);
    return { messageId: `console-${Date.now()}` };
  }
}
