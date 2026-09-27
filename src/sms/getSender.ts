import { env } from "../config/env";
import type { SmsSender } from "./sender";
import { MockSmsSender } from "./mockSender";
import { TwilioSmsSender } from "./twilioSender";

export function getSmsSender(): SmsSender {
  return env.SMS_PROVIDER === "twilio" ? new TwilioSmsSender() : new MockSmsSender();
}
