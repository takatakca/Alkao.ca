/**
 * Run 41: made-up Réservation camping.ca reports, byte for byte as the system sends them
 * (Windows-1252, ";" separated, the real header line). Never real customers.
 */
export const REPORT_HEADER = "Num résrv; Site; Date arrivée; Date départ; nuitées; Nom; Prénom; Nom2; Prénom2; App; Adresse; Ville; CP; Province; Pays; Tel maison; Tel travail; Cellulaire; Courriel; Tarif spécial; Résrv de groupe; Num groupe; Équip. Suppl.; Num équip. suppl.; Ajout de séjour; Num ajout séjour; Type équipement; Longueur; Adultes;\tEnfants;\tAnimaux;\tCommentaires;\tImmatriculation;\tPers. suppl1;\tPers. suppl2;\tPers. suppl3;\tPers. suppl4;\tNbr jour pers. suppl1; Nbr jour pers. suppl2; Nbr jour pers. suppl3; Nbr jour pers. suppl4; Total site; Total pers. suppl.; Rabais; Expl. rabais; Sous-total;\tTPS; TVQ;\tTotal;\tPaiement reçu;\tArrivé; Crée par";
const COLUMNS = REPORT_HEADER.split(";").map((h) => h.trim());

export type ReportLine = Partial<Record<string, string>>;

export function report(lines: ReportLine[]): Uint8Array {
  const body = lines.map((l) => COLUMNS.map((c) => l[c] ?? (["nuitées", "Adultes", "Enfants", "Animaux"].includes(c) ? "0" : c === "Arrivé" ? "Non" : "")).join(";"));
  return Buffer.from([REPORT_HEADER, ...body].join("\r\n") + "\r\n", "latin1");
}

export const line = (num: string, site: string, arrive: string, leave: string, who: ReportLine = {}): ReportLine => ({
  "Num résrv": num, Site: site, "Date arrivée": arrive, "Date départ": leave, nuitées: "2", Adultes: "2", Total: "250.00",
  "Paiement reçu": "100.00", "Crée par": "En Ligne", ...who,
});
