export type SmsSendResult = { sid: string | null };

export interface SmsSender {
  sendSms(args: { to: string; body: string }): Promise<SmsSendResult>;
}
