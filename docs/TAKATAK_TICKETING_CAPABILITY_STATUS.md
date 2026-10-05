# ALKAO — TAKATAK Ticketing Capability Status (Phase A / PR 1)

Date : 2026-10-05
Méthode : lecture seule du code. Aucune écriture dans `takatak-v1` ni `festiiceca`.

**ALKAO** est le nom officiel du Ticket Hub TAKATAK : un moteur de billetterie autonome et
détachable. GROUPE TAKATAK V1 reste le master control plane. Havana Resort et FESTI-ICE
consommeront ALKAO comme deux Clients/Brands distincts.

| Dépôt | Commit inspecté | Rôle |
|---|---|---|
| `takatakca/takatak-v1` | `cc9c57b` (2026-10-04) | Master control plane GROUPE TAKATAK (Next.js + Prisma + Supabase) — **lecture seule** |
| `takatakca/festiiceca` | `a81ffa4` (2026-09-09) | Site public FESTI-ICE (TanStack Start + Supabase, Lovable) — lecture seule |
| `takatakca/Alkao.ca` | `acb4f23` | ALKAO — seule cible d'écriture |

---

## 0. Gates

### 0.1 PROTECT MAIN — `takatak-v1`

| Dépôt | Branche | `protected` | Résultat |
|---|---|---|---|
| `takatak-v1` | `main` (`cc9c57b`) | **false** | Échec constaté — **levé par décision du 2026-10-05** |

Source : `GET /repos/takatakca/takatak-v1/branches` (GitHub API), 2026-10-05. Aucune des
87 branches de `takatak-v1` n'est protégée, `staging` compris.

Décision du propriétaire : `takatak-v1` est inspecté en lecture seule et ce run ne le
modifie jamais ; son gate ne bloque donc pas ALKAO. La protection de `main` sur
`takatak-v1` reste recommandée (Settings → Branches ou Rules → Rulesets : PR obligatoire,
pas de force-push, pas de suppression).

### 0.2 Sécurité de branche — `Alkao.ca` (cible d'écriture)

| Vérification | Constat 2026-10-05 | Statut |
|---|---|---|
| `main` existe | oui — commit racine vide `1cec0b6`, rien d'autre | OK |
| Travail sur une branche dédiée | oui, `claude/amazing-pascal-tppqd4`, livré par PR vers `main` | OK |
| Branche par défaut = `main` | non : GitHub a pris la branche de travail au premier push dans le dépôt vide | **action propriétaire** |
| `main` protégée | `protected = false` | **action propriétaire** |

Règle : ne jamais travailler directement sur la branche par défaut ; tout passe par une PR.
Le proxy GitHub de la session refuse les écritures de paramètres du dépôt (branche par défaut,
protection) ; ces deux réglages se font dans GitHub :

1. Settings → General → Default branch → `main`.
2. Settings → Branches (ou Rules → Rulesets) → règle sur `main` : PR obligatoire, pas de
   force-push, pas de suppression.

---

## 1. Faits — `takatak-v1`

### 1.1 Tenancy (présent, réutilisable)

| Capacité | Statut | Preuve |
|---|---|---|
| Client (tenant) | Présent | `prisma/schema.prisma:354` `model Client` → table `clients` |
| Membership utilisateur ↔ Client | Présent | `prisma/schema.prisma:474` `model ClientMembership` (`@@unique([profileId, clientId])`) |
| Rôles workspace | Présent | `prisma/schema.prisma:33` `enum WorkspaceRole { owner admin manager editor staff viewer }` |
| Brand rattachée à un Client | Présent | `prisma/schema.prisma:561` `model BusinessBrand` (`@@unique([id, clientId])`) |
| Lieu physique | Présent | `prisma/schema.prisma:642` `model BusinessLocation` |
| Un utilisateur, plusieurs Clients | Présent | une ligne `client_memberships` par Client → deux memberships possibles |

Conséquence : « Havana Resort » et « FESTI-ICE » = deux lignes `clients` distinctes, chacune
avec ses `business_brands`. Le modèle existant supporte déjà la décision d'affaires.

### 1.2 Sécurité base de données (présent, à reproduire)

Migration canonique `prisma/migrations/20260909170000_public_rls_and_fk_indexes/migration.sql` :

- RLS activée sur toutes les tables `public`, non forcée (Prisma passe par le propriétaire).
- Helpers `SECURITY DEFINER` placés dans le schéma non exposé `private` (pas d'endpoint `/rpc`).
- Identité = `auth.uid()` + `profiles` + `client_memberships` actifs, jamais `user_metadata`.
- Aucune policy d'écriture pour `anon`/`authenticated` : écritures par le serveur uniquement.
- Secrets, webhooks et jetons : RLS activée, zéro policy, zéro grant.

### 1.3 Ticketing (absent)

| Capacité | Statut | Preuve |
|---|---|---|
| `ServiceType.ticketing` | **Absent** | `prisma/schema.prisma:138-150` : social_media … rentauto, pas de ticketing |
| Permissions Ticketing | **Absent** | `prisma/schema.prisma:60` `enum PermissionKey` sans clé ticketing |
| Tables événement / séance / billet / commande | **Absent** | `grep -i ticket` ne trouve que des tickets de support (`support_tickets`, UI) |
| Scanner / check-in | **Absent** | aucune occurrence |
| Commission transactionnelle | **Absent** | aucune occurrence |

### 1.4 Paiements (présent ailleurs, patron réutilisable)

| Capacité | Statut | Preuve |
|---|---|---|
| Stripe Connect comptes Standard (CA) | Présent pour RentAuto | `supabase/functions/rentauto-stripe-onboard/index.ts:70` `accounts.create({ type: "standard", country: "CA" })` |
| Webhook Stripe signé | Présent | `src/app/api/billing/stripe/webhook/route.ts:43` `constructEvent` |
| Idempotence webhook | Présent (Social) | `prisma/schema.prisma:462` `model StripeWebhookEvent` (`stripeEventId @unique`) |

---

## 2. Faits — `festiiceca` (FESTI-ICE)

### 2.1 Front-end `/billets` (maquette)

| Capacité | Statut | Preuve |
|---|---|---|
| Catalogue de billets | **Statique** | `src/lib/festi-data.ts:211` `ticketTypes` (constante TS) |
| Totaux, taxes | **Client seulement** | `src/routes/billets.tsx:100-108` (`Math.round(taxable * t.rate)`) |
| Règles panier | **Client seulement** | `src/routes/billets.tsx:110-124` (« mirrored client-side ») |
| Passage de commande | **Simulé** | `src/routes/billets.tsx:441` `setPlaced(true)` — aucun appel serveur |
| Paiement, QR, courriel | **Absent** | aucun appel `supabase`/`fetch` dans la route |

### 2.2 Base Supabase (schéma présent, non branché)

Migration `supabase/migrations/20260907133044_0967e6f0-….sql` crée `ticket_types`,
`event_dates`, `time_slots`, `holds`, `orders`, `order_items`, `tickets`, `payments`,
plus `create_hold()` et `redeem_ticket()`. Le front ne les appelle pas (seulement les types
générés, `src/integrations/supabase/types.ts:1285`).

Constats :

1. **Mono-tenant.** Aucune colonne `client_id`. Tout `is_staff_admin` voit toutes les
   commandes. Incompatible avec « Havana Resort et FESTI-ICE = deux Clients distincts ».
2. **⚠️ Fonctions exposées à `anon` (à vérifier sur la base live).** `create_hold` et
   `redeem_ticket` sont `SECURITY DEFINER` dans `public` (lignes 204 et 221), sans
   `REVOKE EXECUTE`. Le seul `REVOKE` du dépôt (`20260904064528`) est antérieur et ne vise
   que `has_role`, `has_any_role`, `is_staff_admin`. Par défaut PostgreSQL accorde `EXECUTE`
   à `PUBLIC` ; si cette migration est appliquée, n'importe qui avec la clé anon peut :
   - appeler `/rest/v1/rpc/redeem_ticket` et marquer un billet « USED » avec un
     `_scanner` arbitraire (le paramètre est fourni par l'appelant) ;
   - appeler `/rest/v1/rpc/create_hold` en boucle et bloquer toute la capacité.
   Correctif minimal à appliquer sur ce projet Supabase :
   `REVOKE EXECUTE ON FUNCTION public.create_hold(uuid, integer, integer), public.redeem_ticket(text, uuid), public.slot_remaining_capacity(uuid) FROM PUBLIC, anon, authenticated;`
3. Capacité calculée par sous-requête sous verrou consultatif — correct, mais pas de compteur
   contraint par `CHECK`.
4. `payments.raw jsonb` stocke la charge brute du fournisseur.

### 2.3 Règles d'affaires réelles (à reprendre dans le domaine)

Source : `festi-data.ts:211-320` et le seed SQL (ligne 236).

| Code | Prix | Règles |
|---|---|---|
| GENERAL | 29,95 $ | 0–10, adulte |
| SENIOR | 27,95 $ | 0–10, adulte |
| CHILD | 17,95 $ | 0–10 |
| TODDLER | 0,00 $ | 0–4, billet requis pour la capacité |
| FAMILY | 21,95 $ / billet | 3–6 billets ; si présent, max 2 billets « adulte » dans la commande |
| OPEN_DATE | 39,95 $ | 0–10, adulte, toute date de la saison |
| GROUP | 26,96 $ | 15–60, adulte |
| FLEX_WEATHER | 8,00 $ / billet | add-on à l'achat seulement ; un changement de date/heure ; différence payable si plus cher |

Taxes : TPS 5 %, TVQ 9,975 %. Séances d'arrivée aux 15 min, 17:00 → 20:30.

À confirmer : la règle « max 2 adultes » de la passe familiale est implémentée côté client
comme « total des types `countsAsAdult` dans la commande ≤ 2 quand FAMILY est présent ».

---

## 3. Décisions confirmées (gelées)

1. Havana Resort et FESTI-ICE = deux Clients distincts dans GROUPE TAKATAK : données,
   acheteurs, commandes, inventaires, permissions et finances séparés ; une personne peut
   avoir deux memberships ; vue consolidée propriétaire plus tard, sans fusion de tenants.
2. Commission V1 : remboursement complet = remboursement complet de la commission
   transactionnelle ; remboursement partiel = remboursement proportionnel. Ne couvre pas
   d'éventuels frais contractuels distincts.
3. Aucune table Ticketing dans `public` sans RLS dans la même migration, avec tests : anon ne
   lit aucune donnée privée ; un Client authentifié ne lit jamais les données d'un autre.
4. Ticketing désactivé par défaut ; chaque route (y compris la création de hold publique)
   vérifie côté serveur l'activation explicite pour le Client et la Brand. Masquer un menu
   n'est pas une mesure de sécurité.
5. Aucune ancienne application supprimée ; construction en parallèle, bascule validée.

---

## 4. Ce qu'ALKAO possède vs ce qu'il consomme de GROUPE TAKATAK

| Capacité | Propriétaire | Mode dans ALKAO |
|---|---|---|
| Identité (comptes, connexion, JWT) | TAKATAK (Supabase Auth) | ALKAO vérifie le JWT ; ne stocke que `user_id` (= `auth.uid()`) |
| Registre Clients | TAKATAK (`clients`) | Projection locale `ticketing_clients` (UUID maître, statut, version) |
| Registre Brands | TAKATAK (`business_brands`) | Projection locale `ticketing_brands` (UUID maître, `client_id`, statut, version) |
| Memberships et rôles | TAKATAK (`client_memberships`, `WorkspaceRole`) | Projection locale `ticketing_memberships` ; rôle → permissions Ticketing calculées par ALKAO |
| Entitlement Ticketing | TAKATAK (entitlements / billing) | Projection locale `ticketing_entitlements` par (Client, Brand) ; absence = désactivé |
| Facturation plateforme (forfaits, frais mensuels) | TAKATAK | Non dupliquée |
| Conditions de commission transactionnelle | TAKATAK (contrat) | Reçues par contrat de contrôle ; calcul et ledger dans ALKAO |
| Dashboard shell | TAKATAK | Consomme l'API ALKAO versionnée (Run 04) |
| Catalogue : lieux, événements, séances, types de billets, add-ons | **ALKAO** | Local |
| Inventaire, capacité, holds | **ALKAO** | Local, invariants en base |
| Acheteurs (par Client), commandes, lignes, taxes | **ALKAO** | Local |
| Billets (identité stable) | **ALKAO** | Local |
| Ledger commission et remboursements | **ALKAO** | Local (exécution Stripe : Run 02) |
| Paiements Stripe Connect | **ALKAO** | Run 02 |
| Credential QR signé, manifeste scanner, scans | **ALKAO** | Run 03 |
| UI Operations | **ALKAO** (exposée dans le dashboard TAKATAK) | Run 04 |

Liaison : contrat de contrôle signé et versionné `alkao.control.v1` (TAKATAK → ALKAO).
ALKAO n'accède jamais directement à la base TAKATAK ; les UUID maîtres sont des
références externes, stockées et validées localement, sans clé étrangère inter-bases.

---

## 5. Architecture approuvée (avec corrections du 2026-10-05)

1. ALKAO : moteur TypeScript autonome et détachable dans `Alkao.ca` — Hono + `pg` +
   migrations SQL + PostgreSQL/RLS.
2. Périmètre Run 01 : **PR 2** = domaine, schéma, RLS, invariants, tests ;
   **PR 3** = contrats d'API et gates d'entitlement. Stripe = Run 02. QR/scanner = Run 03.
   UI Operations = Run 04.
3. `client_id` / `brand_id` = UUID stables émis par TAKATAK V1, traités comme références
   maîtres externes : stockés et validés localement, aucune FK vers la base TAKATAK.
4. Chaque table `ticketing_*` active la RLS dans la migration qui la crée ; tests : anon =
   zéro ligne privée ; isolation inter-Clients.
5. « Testé sur un vrai PostgreSQL » = PostgreSQL local/éphémère uniquement, jamais staging
   ni production.
6. APIs opérationnelles désactivées par défaut et conditionnées par l'entitlement Ticketing
   reçu via le contrat de contrôle TAKATAK avant toute mutation exposée en production.
7. Direction paiement future : Stripe Connect Direct Charges + application fee (Run 02).
8. Direction credential future : QR signé contenant uniquement des identifiants stables
   (credential/billet) et l'information de clé/version — jamais de dates d'événement ou de
   séance ; validité et révocation dans le manifeste scanner (Run 03).
9. Havana Resort et FESTI-ICE restent des Clients TAKATAK distincts ; tout enregistrement
   Ticketing à portée d'affaires exige `client_id` **et** `brand_id`.

Invariants retenus pour PR 2 :

- Inventaire : compteurs `reserved_count` / `sold_count` par séance sous
  `CHECK (reserved_count + sold_count <= capacity)` — survente impossible en concurrence.
- Cohérence tenant : clés étrangères composites `(id, client_id, brand_id)` — un enfant ne
  peut pas pointer vers le parent d'un autre Client ou d'une autre Brand.
- Commission partielle cumulative : `round(commission × total_remboursé / total_payé)` moins
  ce qui a déjà été remboursé ; le remboursement qui atteint le total rend exactement le reste.
- RLS : aucun accès `anon` ; `authenticated` en lecture seule pour les membres actifs du même
  Client (données acheteurs/commandes limitées à owner/admin/manager) ; secrets et boîte de
  réception du contrat sans policy ; aucune policy d'écriture.
