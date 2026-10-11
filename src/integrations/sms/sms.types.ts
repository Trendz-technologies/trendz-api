/**
 * SMS messages are sent through DLT-registered templates (mandatory in India).
 * Three templates cover every message the platform sends:
 *
 *   OTP       "##otp## is your Trendz verification code. Valid for ##minutes## minutes. Do not share it."
 *   ORDER     "Trendz: update on order ##order##: ##message##"
 *   SHIPPING  "Trendz: your order ##order## is ##status##. Track: ##url##"
 *
 * The variable names above must match the variables configured in the
 * provider's template (e.g. MSG91 Flow).
 */
export type SmsTemplate = "OTP" | "ORDER" | "SHIPPING";

export interface SmsMessage {
  /** E.164 phone number, e.g. +919876543210 */
  to: string;
  template: SmsTemplate;
  variables: Record<string, string>;
  /** Rendered text, used for logs and by providers without template support. */
  text: string;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<{ messageId: string | null }>;
}

export function renderSmsText(template: SmsTemplate, v: Record<string, string>): string {
  switch (template) {
    case "OTP":
      return `${v.otp} is your Trendz verification code. Valid for ${v.minutes} minutes. Do not share it.`;
    case "ORDER":
      return `Trendz: update on order ${v.order}: ${v.message}`;
    case "SHIPPING":
      return `Trendz: your order ${v.order} is ${v.status}. Track: ${v.url}`;
  }
}

/** Text safe to store in sms_logs: OTP values are never persisted. */
export function maskForLog(template: SmsTemplate, text: string, v: Record<string, string>): string {
  return template === "OTP" && v.otp ? text.replaceAll(v.otp, "******") : text;
}
