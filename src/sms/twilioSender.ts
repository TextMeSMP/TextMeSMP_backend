import type { SmsSender, SmsSendResult } from "./sender";
import { env } from "../config/env";
import twilio from "twilio";

export class TwilioSmsSender implements SmsSender {
  private client = twilio(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!);
  private from = env.TWILIO_NUMBER!;

  constructor() {
    // Fail fast with clear message
    const missing: string[] = [];
    if (!env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
    if (!env.TWILIO_AUTH_TOKEN) missing.push("TWILIO_AUTH_TOKEN");
    if (!env.TWILIO_NUMBER) missing.push("TWILIO_NUMBER");
    if (missing.length) {
      throw new Error(
        `SMS_PROVIDER=twilio but missing env vars: ${missing.join(", ")}`
      );
    }
  }

  async sendSms(args: { to: string; body: string }): Promise<SmsSendResult> {
    const msg = await this.client.messages.create({
      from: this.from,
      to: args.to,
      body: args.body,
    });
    return { sid: msg.sid };
  }
}
