# ALKAO credentials and gates (Run 03)

## QR payload: `ALK1`

```
ALK1.<kid>.<credential id>.<signature>
```

| Part | Content |
|---|---|
| `ALK1` | Format tag (version) |
| `kid` | Signing key id, `k` + 10 base-36 characters. It identifies the Client's key and its version |
| credential id | The credential's UUID as 16 bytes, base64url (22 characters) |
| signature | Ed25519 over `ALK1.<kid>.<credential id>`, base64url (86 characters) |

Frozen rule: the QR code carries **only stable identifiers and key information**. It contains
no event or session date, no price and no buyer data. Admission windows and revocation come
from the scanner manifest. A payload is about 126 characters long.

**Credentials.**
- Every ticket receives exactly one active credential, issued by a database trigger.
- Voiding a ticket (refund, cancellation) revokes its credential, also by trigger.
- *Reissue* (lost phone, shared screenshot) revokes the current credential and issues a new
  one. Admission is counted per **ticket**, so a reissued credential never allows a second
  entry.

**Keys.**
- Each Client has its own versioned Ed25519 key. Private keys are **never stored**: they are
  derived on demand from `ALKAO_CREDENTIAL_MASTER_SECRET`, using HKDF-SHA256 with salt
  `alkao.credential.v1` and info `<clientId>:<version>`.
- The database keeps only public keys.
- **Rotation** (`POST …/credential-keys/rotate`, owner/admin) signs new QR codes with the new
  version. The old key moves to `retired` and keeps verifying existing codes until an
  administrator sets it to `revoked`.
- A key from another Client never verifies at this Client's gates.

## Manifest: `GET …/sessions/:sessionId/scanner-manifest`

Permission `ticketing.scan` (owner, admin, manager, staff). The manifest is valid for 10 minutes.

```json
{
  "format": "alkao.scanner.v1",
  "generatedAt": "…", "validUntil": "…",
  "session": { "id": "…", "eventId": "…", "startsAt": "…", "endsAt": null,
               "admission": { "opensAt": "…", "closesAt": "…" } },
  "keys": [{ "kid": "k…", "algorithm": "Ed25519", "publicKey": "<32 bytes base64url>", "status": "active" }],
  "credentials": [{ "id": "<uuid>", "qrId": "<as in the QR>", "ticketTypeCode": "CHILD", "ticketTypeName": "Enfant — 2 à 12 ans" }],
  "admitted": [{ "id": "…", "qrId": "…" }],
  "revoked": [{ "id": "…", "qrId": "…" }]
}
```

The admission window is set per event: `admissionOpensBeforeMinutes` (default 60) before the
session starts, until `admissionClosesAfterMinutes` (default 120) after it ends, or after it
starts if it has no end.

**Offline check on a gate device:**
1. Parse `ALK1`.
2. Find `kid` in `keys`.
3. Verify the Ed25519 signature.
4. Admit if `qrId` is in `credentials`, is not already admitted on this device, and the clock is inside the window.

The device then uploads its scans when it is back online.

**In the Operations app (Run 09).** Scanner, then **Préparer le mode hors ligne**: the device
stores the session's manifest. With no network, it checks each code itself:

1. the `ALK1` format and the key id;
2. the Ed25519 signature, through WebCrypto;
3. revocation;
4. whether the ticket was already admitted (manifest or this device);
5. the gate window.

Every attempt is queued in the device's storage and sent through `scans/batch`: every 15 s
once online, or with **Synchroniser maintenant**. After a sync the device downloads a fresh
manifest. The server stays the authority. When a ticket admitted offline turns out to have
entered at another gate, it is counted and shown as a conflict ("aussi entré à une autre
porte"); the gate log keeps a single admission. The manifest holds no buyer data, only
credential ids and ticket type names.

## Scans

| Route | Use |
|---|---|
| `POST …/scanner/scans` `{ sessionId, payload, deviceId? }` | Online scan |
| `POST …/scanner/scans/batch` `{ sessionId, deviceId, scans: [{ payload, scannedAt }] }` | Offline sync (≤ 500), applied in device-time order; device clocks more than 5 min ahead are clamped |
| `GET …/sessions/:sessionId/scans` | Gate log |
| `POST …/tickets/:ticketId/credential/reissue` | New QR code (owner, admin, manager) |

Results: `admitted`, `already_admitted` (with `admittedAt` and the device), `revoked`,
`wrong_session`, `too_early`, `too_late`, `unknown_credential`, `invalid_signature`,
`unknown_key`, `malformed`.

Every attempt is logged in `ticketing_scans`, which is append-only. A unique index admits each
ticket **at most once** across every gate. Under concurrent scans exactly one gets
`admitted`, and the others get `already_admitted`.

The buyer gets the QR payload for each valid ticket in `GET /v1/public/…/orders/:orderId`
(`tickets[].credential`). The website or the confirmation email turns it into a QR code.

## Without a QR code (Run 22)

When a buyer's phone is dead or the code will not read, gate staff find the order by its
reference (on the confirmation email) and let a ticket in by hand.

| Method | Path | Permission | Result |
|---|---|---|---|
| GET | `/v1/admin/…/sessions/:sessionId/lookup?reference=` | `scan` | `{ order: { reference, tickets: [{ id, ticketTypeName, status, admittedAt }], otherSessions: [{ startsAt }] } }`. Only the tickets for this session. `otherSessions` says when the order's other valid tickets are for |
| POST | `/v1/admin/…/scanner/admit` | `scan` | `{ sessionId, ticketId, deviceId? }` → `{ scan }`, the same outcome as a QR scan |

- **Same rules as a scan.** A ticket enters at most once, only for this session, and only
  while the doors are open. It is refused if cancelled (`revoked`, `wrong_session`,
  `already_admitted`, `too_early`, `too_late`).
- **Logged.** Each attempt is a scan from the device, and each manual entry is also written
  to the audit log (`scan.manual_admission`, with the staff member and the device).
- **No buyer data for the gate.** Gate staff see no buyer data. Roles that read buyers
  (owner, admin, manager) also get `buyerName`, to check it against an ID.
- **Session changes.** The reference of the original order also finds the tickets it was
  moved to by a session change (Flex Météo, or each change of an open-date ticket).
- **Online only.** It works online only. In offline mode the Scanner says so.
