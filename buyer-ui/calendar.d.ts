// Types for buyer-ui/calendar.js (Run 31), used by its unit tests. Not served.
export function escapeText(s: string): string;
export function fold(line: string): string;
export function calendarFile(
  e: {
    orderId: string;
    title: string;
    startsAt: string;
    endsAt?: string | null;
    venue: { name: string; addressLine1?: string | null; city?: string | null };
    description: string;
  },
  now?: Date,
): string;
