// ALKAO Run 41: reads a Réservation camping.ca reservations report ("Données de réservations",
// reservations.csv: Windows-1252, ";" separated) in the browser and in Node. Only the fields
// the customer file keeps are read: comments, licence plates, extra people's names, payment
// and tax columns never leave this function, so they are never uploaded.

const FIELDS = {
  "Num résrv": "sourceRef", Site: "item", "Date arrivée": "startsOn", "Date départ": "endsOn",
  Nom: "lastName", Prénom: "firstName", Nom2: "companionLastName", Prénom2: "companionFirstName",
  App: "addressUnit", Adresse: "addressLine", Ville: "city", CP: "postalCode", Province: "region", Pays: "country",
  "Tel maison": "homePhone", "Tel travail": "workPhone", Cellulaire: "mobilePhone", Courriel: "email",
  "Résrv de groupe": "groupBooking", Adultes: "adults", Enfants: "children", Animaux: "pets", Total: "total", Arrivé: "arrived",
};
// A ";" typed inside one of these shifts the rest of the row; it is glued back where the row reads right.
const TEXT_FIELDS = ["Nom", "Prénom", "Nom2", "Prénom2", "App", "Adresse", "Ville", "Type équipement", "Commentaires", "Immatriculation",
  "Pers. suppl1", "Pers. suppl2", "Pers. suppl3", "Pers. suppl4", "Expl. rabais", "Tarif spécial", "Crée par"];

/** UTF-8 when the bytes are valid UTF-8 (a file saved again by Excel), Windows-1252 otherwise. */
export function decodeReport(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = new TextDecoder("windows-1252").decode(bytes); }
  return text.replace(/^﻿/, "");
}

/** RFC 4180 rows with a chosen separator (quotes optional). */
export function splitRows(text, sep = ";") {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
const isCount = (s) => s.trim() === "" || /^\d{1,3}$/.test(s.trim());
const isAmount = (s) => s.trim() === "" || /^-?\d+(?:[.,]\d+)?$/.test(s.trim());

function readsRight(r, at) {
  const v = (name) => (at[name] === undefined ? "" : r[at[name]] ?? "");
  return isDate(v("Date arrivée")) && isDate(v("Date départ")) && ["nuitées", "Adultes", "Enfants", "Animaux"].every((n) => isCount(v(n)))
    && ["Total", "Paiement reçu"].every((n) => isAmount(v(n))) && ["Oui", "Non", ""].includes(v("Arrivé").trim());
}

function repair(r, header, at) {
  const extra = r.length - header.length;
  if (extra === 0) return readsRight(r, at) ? r : null;
  if (extra < 0) return null;
  for (const name of TEXT_FIELDS) {
    const j = at[name];
    if (j === undefined) continue;
    const glued = [...r.slice(0, j), r.slice(j, j + extra + 1).join(";"), ...r.slice(j + extra + 1)];
    if (readsRight(glued, at)) return glued;
  }
  return null;
}

const count = (s) => Math.min(Number.parseInt(s, 10) || 0, 500);
const cents = (s) => Math.max(0, Math.round(Number((s || "0").replace(",", ".")) * 100) || 0);
const cut = (s, max) => s.slice(0, max) || null;
const joinName = (first, last) => [first, last].map((s) => s.trim()).filter(Boolean).join(" ");

/**
 * Report bytes → import rows for POST …/customers/import, plus what was left out.
 * Throws "not_a_reservations_report" when the columns are not those of the report.
 */
export function parseReservationsReport(bytes) {
  const rows = splitRows(decodeReport(bytes));
  const header = (rows[0] ?? []).map((h) => h.trim());
  const at = Object.fromEntries(header.map((h, i) => [h, i]));
  if (at["Num résrv"] === undefined || at["Date arrivée"] === undefined || at["Date départ"] === undefined) {
    throw new Error("not_a_reservations_report");
  }
  const out = [];
  let unreadable = 0, repaired = 0;
  for (const raw of rows.slice(1)) {
    const r = repair(raw, header, at);
    if (!r) { unreadable++; continue; }
    if (r !== raw) repaired++;
    const f = {};
    for (const [column, key] of Object.entries(FIELDS)) f[key] = at[column] === undefined ? "" : (r[at[column]] ?? "").trim();
    if (!f.sourceRef) { unreadable++; continue; }
    const companion = joinName(f.companionFirstName, f.companionLastName);
    out.push({
      sourceRef: f.sourceRef.slice(0, 80), item: cut(f.item, 80),
      startsOn: f.startsOn, endsOn: f.endsOn < f.startsOn ? f.startsOn : f.endsOn,
      adults: count(f.adults), children: count(f.children), pets: Math.min(count(f.pets), 100),
      groupBooking: /^(oui|o|yes|1|true)$/i.test(f.groupBooking), checkedIn: f.arrived === "Oui", totalCents: Math.min(cents(f.total), 100_000_000),
      firstName: cut(f.firstName, 120), lastName: cut(f.lastName, 120), companionName: cut(companion, 200),
      email: cut(f.email, 320), mobilePhone: cut(f.mobilePhone, 40), homePhone: cut(f.homePhone, 40), workPhone: cut(f.workPhone, 40),
      addressLine: cut(f.addressLine, 200), addressUnit: cut(f.addressUnit, 40), city: cut(f.city, 120),
      region: cut(f.region, 60), postalCode: cut(f.postalCode, 20), country: cut(f.country, 60),
    });
  }
  return { rows: out, unreadable, repaired };
}
