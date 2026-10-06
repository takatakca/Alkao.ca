/** Run 41: types for ops-ui/reservations-csv.js (shared by the browser app and the import script). */
export interface ReservationImportRow {
  sourceRef: string;
  item: string | null;
  startsOn: string;
  endsOn: string;
  adults: number;
  children: number;
  pets: number;
  groupBooking: boolean;
  checkedIn: boolean;
  totalCents: number;
  firstName: string | null;
  lastName: string | null;
  companionName: string | null;
  email: string | null;
  mobilePhone: string | null;
  homePhone: string | null;
  workPhone: string | null;
  addressLine: string | null;
  addressUnit: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}
export function decodeReport(bytes: Uint8Array): string;
export function splitRows(text: string, sep?: string): string[][];
export function parseReservationsReport(bytes: Uint8Array): { rows: ReservationImportRow[]; unreadable: number; repaired: number };
