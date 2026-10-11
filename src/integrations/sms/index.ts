import { env } from "../../config/env";
import { ConsoleSmsProvider } from "./mock/console-sms.provider";
import { Msg91SmsProvider } from "./msg91.provider";
import type { SmsProvider } from "./sms.types";

let provider: SmsProvider | null = null;

/** The configured SMS provider. Business code depends only on SmsProvider. */
export function smsProvider(): SmsProvider {
  if (provider) return provider;
  if (env.SMS_PROVIDER === "msg91") {
    if (!env.SMS_API_KEY) throw new Error("SMS_PROVIDER=msg91 requires SMS_API_KEY");
    provider = new Msg91SmsProvider(env.SMS_API_KEY);
  } else {
    provider = new ConsoleSmsProvider();
  }
  return provider;
}

export * from "./sms.types";
