# alkao.control.v1 — TAKATAK → ALKAO control contract

GROUPE TAKATAK (master control plane) is the source of truth for Clients, Brands,
memberships and the Ticketing entitlement. It pushes them to ALKAO through this contract.
ALKAO never reads the TAKATAK database. It stores local projections keyed by the TAKATAK
master UUIDs, which it treats as external references.

- Machine-readable schema: [`contracts/alkao-control.v1.schema.json`](../contracts/alkao-control.v1.schema.json)
  (generated from `src/contracts/control-v1.ts`; a test fails if the two drift apart).
- Endpoint: `POST /v1/control/events`, one event per request.

## Authentication

| Header | Value |
|---|---|
| `X-Alkao-Key-Id` | Key id agreed with ALKAO (rotation: several ids can be active) |
| `X-Alkao-Timestamp` | Unix time in seconds; must be within ±300 s of ALKAO's clock |
| `X-Alkao-Signature` | `v1=` + hex `HMAC-SHA256(secret, "<timestamp>.<raw body>")` |

ALKAO configuration: `ALKAO_CONTROL_KEYS="kid1:secret1,kid2:secret2"`, with secrets of at least
32 characters. With no key configured, the endpoint answers `503 control_not_configured`.

## Envelope

```json
{
  "contract": "alkao.control.v1",
  "eventId": "uuid — unique per event, reused on redelivery",
  "issuedAt": "2026-10-05T12:00:00Z",
  "type": "client.upserted | brand.upserted | membership.upserted | membership.removed | entitlement.updated",
  "data": { "...": "...", "version": 1 }
}
```

`data.version` is TAKATAK's monotonic version for that subject (Client, Brand, membership or
entitlement). For example, an `updatedAt` in milliseconds or a sequence number.

## Event types

| Type | `data` | Effect in ALKAO |
|---|---|---|
| `client.upserted` | `clientId, name, status (active/suspended/archived), timezone, commission {rateBps, fixedCentsPerPaidAdmission}, version` | Upsert `ticketing_clients` |
| `brand.upserted` | `clientId, brandId, name, status, version` | Upsert `ticketing_brands`. The Client must exist; a Brand never moves to another Client |
| `membership.upserted` | `clientId, userId (Supabase auth uid), role (owner/admin/manager/editor/staff/viewer), status (active/suspended), version` | Upsert `ticketing_memberships` |
| `membership.removed` | `clientId, userId, version` | Stored as `suspended`, so an older upsert can never bring it back |
| `entitlement.updated` | `clientId, brandId, status (active/inactive/suspended), validFrom?, validUntil?, version` | Upsert `ticketing_entitlements` for that exact Client/Brand pair |

## Delivery semantics

| Response | Meaning | TAKATAK action |
|---|---|---|
| `200 {"outcome":"applied"}` | Projection updated | Done |
| `200 {"outcome":"stale"}` | ALKAO already holds a newer or equal version | Done |
| `200 {"outcome":"duplicate"}` | This `eventId` was already processed | Done |
| `400 invalid_request` / `invalid_json` | Payload does not match the schema | Fix, do not retry as-is |
| `401 invalid_signature` | Bad key id, signature or timestamp | Fix signing |
| `409 unknown_client` / `unknown_brand` | Parent not projected yet | Send the parent, then retry the same event |
| `409 brand_client_mismatch` | Brand belongs to another Client | Investigate; never retried automatically |

Every applied event writes `ticketing_audit_log` (`actor_type = control`, `actor_id = key id`).

## What the entitlement controls

ALKAO is **disabled by default**. A route serves a Client/Brand only when all of these hold:

1. The deployment switch `ALKAO_OPERATIONAL_API_ENABLED=true` is set;
2. the Client and Brand exist, the Brand belongs to the Client, and both are `active`;
3. an `entitlement.updated` with `status = active` exists for **that exact pair**, inside its
   `validFrom`/`validUntil` window.

An entitlement for one Brand never enables another Brand of the same Client.
