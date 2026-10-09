import qrcode from "qrcode-generator";
import type { TenantScope } from "../db/commerce.js";
import type { Db, Tx } from "../db/pool.js";
import type { EmailAttachment } from "./email.js";

type Queryable = Db | Tx;

/**
 * Run 52: the QR codes inside the tickets and reminder e-mails, so the buyer can show the
 * e-mail at the gate even if they never opened the tickets page (e-mail apps keep messages
 * readable offline). Same codes as the tickets page; the scanner still decides. Above this
 * many tickets the e-mail keeps the link only, so it stays small enough to arrive.
 */
export const MAX_CODES_IN_EMAIL = 10;

export interface EmailCode {
  /** Content-ID of the inline image (cid:…). */
  cid: string;
  /** The ticket type, as on the order. */
  label: string;
  /** The ticket's short code, as on the tickets page. */
  code: string;
}

/** A QR code as a GIF (base64), dark on white, like the tickets page. */
export function qrGif(payload: string): string {
  const qr = qrcode(0, "M");
  qr.addData(payload);
  qr.make();
  return qr.createDataURL(5, 4).split(",")[1]!;
}

interface Credentials {
  payloadsForOrder(scope: TenantScope, orderId: string): Promise<Map<string, string>>;
}

/**
 * The order's valid tickets with their QR codes, as inline images, in the order the tickets
 * page shows them. Null when there is nothing to show inline (no credential yet) or too many.
 */
export async function emailCodes(
  q: Queryable,
  credentials: Credentials,
  scope: TenantScope,
  orderId: string,
): Promise<{ codes: EmailCode[]; attachments: EmailAttachment[] } | null> {
  const payloads = await credentials.payloadsForOrder(scope, orderId);
  if (payloads.size === 0 || payloads.size > MAX_CODES_IN_EMAIL) return null;
  const { rows } = await q.query<{ id: string; name: string }>(
    `SELECT t.id, l.name_snapshot AS name
     FROM public.ticketing_tickets t
     JOIN public.ticketing_order_lines l ON l.id = t.order_line_id AND l.client_id = t.client_id AND l.brand_id = t.brand_id
     LEFT JOIN public.ticketing_ticket_types tt ON tt.id = t.ticket_type_id AND tt.client_id = t.client_id AND tt.brand_id = t.brand_id
     WHERE t.order_id = $1 AND t.client_id = $2 AND t.brand_id = $3 AND t.status = 'valid'
     ORDER BY tt.sort_order NULLS LAST, t.created_at, t.id`,
    [orderId, scope.clientId, scope.brandId],
  );
  const codes: EmailCode[] = [];
  const attachments: EmailAttachment[] = [];
  for (const row of rows) {
    const payload = payloads.get(row.id);
    if (!payload) continue;
    const code = row.id.slice(0, 8).toUpperCase();
    const cid = `billet-${row.id.slice(0, 8)}@alkao`;
    codes.push({ cid, label: row.name, code });
    attachments.push({ filename: `billet-${code}.gif`, content: qrGif(payload), contentType: "image/gif", contentId: cid });
  }
  return codes.length ? { codes, attachments } : null;
}
