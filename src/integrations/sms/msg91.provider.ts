import { env } from "../../config/env";
import type { SmsMessage, SmsProvider, SmsTemplate } from "./sms.types";

/** MSG91 Flow API (DLT template based). https://docs.msg91.com */
export class Msg91SmsProvider implements SmsProvider {
  readonly name = "msg91";

  constructor(private readonly authKey: string) {}

  private templateId(t: SmsTemplate): string {
    const id = { OTP: env.SMS_TEMPLATE_OTP, ORDER: env.SMS_TEMPLATE_ORDER, SHIPPING: env.SMS_TEMPLATE_SHIPPING }[t];
    if (!id) throw new Error(`SMS template id for ${t} is not configured (SMS_TEMPLATE_${t})`);
    return id;
  }

  async send(m: SmsMessage) {
    const mobiles = m.to.replace(/^\+/, "");
    const res = await fetch("https://control.msg91.com/api/v5/flow", {
      method: "POST",
      headers: { authkey: this.authKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        template_id: this.templateId(m.template),
        sender: env.SMS_SENDER_ID,
        short_url: "0",
        recipients: [{ mobiles, ...m.variables }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || body.type === "error") {
      throw new Error(`MSG91 responded ${res.status}: ${body.message ?? "unknown error"}`);
    }
    return { messageId: body.message ?? null };
  }
}
