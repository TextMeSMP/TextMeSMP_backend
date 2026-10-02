import type { SmsSender, SmsSendResult } from "./sender";

export class MockSmsSender implements SmsSender {
  async sendSms(args: { to: string; body: string }): Promise<SmsSendResult> {
    console.log("\n--- MOCK SMS ---");
    console.log("To:", args.to);
    console.log(args.body);
    console.log("--- END MOCK SMS ---\n");
    return { sid: null };
  }
}
