/** Outgoing email: the buyer's emails, and the Brand's campaigns (Run 42). */
export interface EmailMessage {
  to: string;
  /** Display name, e.g. the Brand ("Havana Resort"). The address is ALKAO_EMAIL_FROM. */
  fromName: string;
  subject: string;
  text: string;
  html: string;
  /** Same key for every attempt of the same message: the provider sends it once. */
  idempotencyKey: string;
  /** Run 42: extra headers (List-Unsubscribe on campaigns). */
  headers?: Record<string, string>;
}

export class EmailSendError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export interface EmailSender {
  /** Resolves with the provider's message id. Throws EmailSendError. */
  send(message: EmailMessage): Promise<string | null>;
}

/** A Brand name as a safe "From" display name: no quotes, backslashes or line breaks. */
const displayName = (name: string) =>
  `"${name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/["\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 100)}"`;

/** Resend (https://resend.com) over its HTTPS API. */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(m: EmailMessage): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": m.idempotencyKey,
        },
        body: JSON.stringify({
          from: `${displayName(m.fromName)} <${this.fromAddress}>`, to: [m.to], subject: m.subject.replace(/[\r\n]+/g, " ").slice(0, 300), text: m.text, html: m.html,
          ...(m.headers ? { headers: m.headers } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new EmailSendError(`network: ${(error as Error).message}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new EmailSendError(`resend ${res.status}: ${body.name ?? ""} ${body.message ?? ""}`.trim(), retryable);
    }
    return body.id ?? null;
  }
}
