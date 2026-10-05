// Language of the buyer pages (Run 16): ?lang=en|fr in the address, else the visitor's last
// choice, else the browser's language. French is the default.
const KEY = "alkao.lang";
export function pickLanguage() {
  const asked = new URLSearchParams(location.search).get("lang");
  if (asked === "fr" || asked === "en") { try { localStorage.setItem(KEY, asked); } catch {} return asked; }
  try { const saved = localStorage.getItem(KEY); if (saved === "fr" || saved === "en") return saved; } catch {}
  return (navigator.language || "fr").toLowerCase().startsWith("en") ? "en" : "fr";
}
export function switchLanguage(to) {
  try { localStorage.setItem(KEY, to); } catch {}
  const url = new URL(location.href);
  url.searchParams.delete("lang");
  location.replace(url.toString());
  location.reload();
}
export const localeOf = (lang) => (lang === "en" ? "en-CA" : "fr-CA");
