import { DomainError } from "./errors.js";

/**
 * Run 50: a Brand's colours must stay readable. The accent colour is a background (buttons,
 * the ticket's band) and its text colour sits on it: together they must reach WCAG AA for
 * normal text, a contrast of 4.5 to 1.
 */
export const MIN_CONTRAST = 4.5;

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of "#rrggbb". */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two "#rrggbb" colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Refuses an accent colour and text colour that would be hard to read together. */
export function assertReadableColours(accent: string | null, onAccent: string | null): void {
  if (!accent || !onAccent) return;
  const ratio = contrastRatio(accent, onAccent);
  if (ratio < MIN_CONTRAST) throw new DomainError("appearance_low_contrast", { ratio: Math.round(ratio * 100) / 100, minimum: MIN_CONTRAST });
}
