# ALKAO — Agent handoff (mandatory)

## Run 102 — alkao.ca down since 2026-10-22; empty settings no longer stop the server (2026-10-24)

- **Live state (2026-10-24):**
  - `https://alkao.ca/health` answers 503 "no available server" (Traefik: no healthy ALKAO container). The Live workflow is red since 2026-10-22 12:05 UTC.
  - Verify deployment at 09:36 UTC on 10-22 still saw the old build 26a48ec, schema current. The container stopped between 09:36 and 12:05; nothing in GitHub says why.
  - promohavana.ca still sells through Weezevent: Promo Havana PR #29 was never deployed.
- **Ruled out:** the merged migrations (Runs 97–99). A database built at 26a48ec with data, then migrated with `main`, boots `scripts/container.ts` with `/health/ready` 200.
- **Probable cause:** a Coolify variable cleared instead of deleted (step 4 of `CE_SOIR_HAVANA.md`: `ALKAO_HOME_URL`), or a malformed pasted key. `EnvSchema` threw a `ZodError` at boot for `""`.
- **Fix:**
  - `settingsOf` in `src/config.ts` trims values and treats empty ones as unset. A bad value throws "ALKAO cannot start: fix NAME…", with names only and never values.
  - `check:golive` warns about an empty setting instead of failing.
  - `live-watch` explains a proxy 502–504.
- **Tests:** `test/api/config.test.ts`, `test/ops/golive.test.ts`, `test/ops/live-watch.test.ts`.
- **Owner steps:** the top of `docs/CE_SOIR_HAVANA.md`. Read the Coolify logs, delete or fix the variable, Redeploy, check `/health`.
- NEXT EXACT ACTION: merge the Run 102 PR. Then the operator redeploys ALKAO in Coolify, and `npm run check:golive -- --url https://alkao.ca` must pass the health lines.


## Run 101 — presale countdown, presale and coupon results (2026-10-22)

- Shop (`shop-ui/app.js`):
  - in a presale's last 48 hours, its end date becomes "Se termine dans 5 h 12 min", on the row and in the hero (`endsIn` and `presaleEnd`);
  - a minute clock runs only while a presale ends within 48 hours. At the end, the shop reloads the event, so the presale row goes away.
- Reports (`src/ops/reports.ts`, `salesReport`):
  - `ticketTypes` rows carry `presale` and `pass`;
  - new `promoCodes` rows: code, public, orders, discount, gross, refunded, under the same filters.
  - /ops shows both under "Détail des ventes".
- Tests: the Run 101 cases in `test/payments/presale-coupons.test.ts` and `test/ui/presale-ui.test.ts`.
- Merged f357d08 (PR #96).


## Run 100 — festival passes in the e-mails and on alkao.ca (2026-10-22)

- E-mails (`src/delivery/templates.ts`, `worker.ts`): the tickets and reminder e-mails take `passDates` from `orderPassDates` (`src/delivery/db.ts`), which lists the other dates of the order's valid pass tickets, cancelled dates aside. They add "Valide aussi : …" and "Votre passe entre une fois par date, avec le même code QR."
- alkao.ca:
  - `eventDeals` also returns the cheapest pass on sale;
  - a card with two dates or more shows "Passe festival · N dates" (the `is-pass` ribbon, ticket icon) when no presale or coupon is on;
  - a pass is never a deal, so it stays out of the "Préventes et rabais" rail.
- Tests: the e-mail case in `test/scanner/festival-pass.test.ts`, and the pass ribbon in `test/api/home-deals.test.ts`.
- Merged f9095a7 (PR #95).


## Run 99 — catalog files with presales, passes and coupons; coupons kept off presales (2026-10-22)

- `events:import` (`src/ops/events-import.ts`):
  - a ticket type may name its regular ticket with `presaleOfCode`. The regular tickets are created first, then each presale is checked against `CreateTicketType`, so the Run 97 rules still apply;
  - `pass: true` makes a festival pass;
  - `promoCodes` (`CreatePromoCode`) creates codes and public coupons;
  - as for the rest of the file, a code already there is kept as it is. The result lists `promoCodes: { created, kept }`.
- Migration `20261122000100_alkao_coupon_excludes_presales.sql`: `ticketing_promo_codes.excludes_presales`.
  - `discountBase` in `src/domain/pricing.ts` takes such a code off the regular-price lines only. Quote lines carry `presale`, for carts and for hold items alike (`lockHoldForCheckout`), so the quote, the hold and the checkout agree.
  - A cart of presale tickets only is refused with `promo_code_invalid` and `{ reason: "presale_only" }` (`promoApplies`).
  - /ops: "Non cumulable avec la prévente" on creation, and a toggle in the codes table.
  - Shop: the coupon says "hors prix prévente" while a presale is on, and the refusal has its own message.
- Tests:
  - Run 99 cases in `test/ops/events-import.test.ts` and `test/payments/presale-coupons.test.ts`;
  - `test/ui/presale-ui.test.ts` and `test/ui/presale-ops.test.ts`.
- Merged 7b17b0a (PR #94).


## Run 98 — festival passes (2026-10-22)

- One ticket, one QR code, valid once at every session of its event on sale when it was bought (a weekend, a three-day festival). Owner guide: `docs/PASSES_FESTIVAL.md`.
- 98a, data (migration `20261121000100_alkao_festival_passes.sql`):
  - `ticket_types.pass` (admission only, never `open_date`).
  - The order and ticket belong to the first covered session. The other sessions' seats are rows:
    - `ticketing_hold_pass_seats` while in the cart;
    - `ticketing_ticket_pass_seats` once paid.
    Triggers move `reserved_count` and `sold_count` on each session, so the capacity CHECK protects every day.
  - Locks follow the sessions' time order on creation and release. `expireStaleHolds` runs for each covered session, in order.
  - `ticketing_scans_one_admission` is now unique per (ticket, session).
  - The scanner admits a pass at a covered session (`passCovers`). Offline manifests and lookup by reference include pass tickets.
  - Refused: mixed carts (`pass_cart_mixed`), session change (`pass_cannot_change_session`), transfer (`pass_not_transferable`).
  - Cancelling one session never refunds a pass (`cancellation.ts` skips pass tickets).
- 98b, buyers and staff:
  - Shop:
    - a "Billet d'un jour / Passe festival" switch; pass mode lists the dates and what is left (the fullest date's seats);
    - a pass-only event opens on the pass;
    - the hero offers the pass, and a click switches the panel to it.
  - Tickets page: "Valide aussi" lists the other dates. The calendar file adds one entry per date.
  - /ops: the "Passe festival (toutes les dates)" checkbox, and "· passe festival" in the ticket types table. A presale of a pass stays a pass.
  - Public availability and the waitlist no longer count lapsed pass carts' seats on the other days.
- Tests: `test/scanner/festival-pass.test.ts` (7) and `test/ui/festival-pass-ui.test.ts` (2).
- Merged 21cc80d (PR #93). The import and the coupon option followed in Run 99.


## Run 97 — presales and discount coupons, for any event (2026-10-22)

- The owner's new line of business: presales with discount coupons, for all kinds of events of one to three days. That means festivals, food, clothing sales, markets and fairs. Owner guide: `docs/PREVENTES_COUPONS.md`.
- 97a, data (migration `20261120000100_alkao_presales_coupons.sql`):
  - A presale ticket is an ordinary ticket type tied to the regular one (`presale_of`). Because it is an ordinary type, holds, payments, QR codes, scans and refunds work unchanged.
    - Its price stays below the regular price. A trigger checks both rows, either way round.
    - It must end on a date (`sales_end_at`), after a quantity (`quantity_limit`), or both.
  - `quantity_limit` counts the whole event in `ticketing_ticket_type_counts`, using the same triggers as add-on stock (Run 49):
    - a cart past the limit is refused with `ticket_type_sold_out`; a payment never is;
    - lapsed holds never count, even before the sweep;
    - a full refund gives the tickets back;
    - a session change moves nothing.
    Setting a limit later recounts. It is refused below what is already sold or held (`quantity_limit_below_committed`).
  - Promo codes gain `public` and `label`. `publicCoupons` returns the codes usable now, with what is left.
  - New categories: `gastronomie`, `mode` and `marches`.
  - Duplicating an event keeps its presales, against the copy's own regular ticket. The end date moves with the sessions.
- 97b, buyers:
  - Shop:
    - the presale row comes right before its regular ticket, with the badge, the saving rounded down, the regular price struck through, its end and what is left;
    - the hero shows the presale against its own regular price, never next to "À partir de";
    - coupon cards apply in one click, and `?coupon=CODE` applies one on arrival.
  - alkao.ca:
    - each card shows a deal ribbon ("Prévente −20 %" or "Coupon −15 %");
    - a "Préventes et rabais" rail appears from four events;
    - a presale with nothing left is no longer the "À partir de" price;
    - the three categories have Unsplash photos, credited in `home-ui/CREDITS.md`. Category guessing ignores "mode" and "marche" used alone.
- 97c, /ops:
  - "Prix de prévente" makes the presale ticket from a regular one. The ticket types table shows each presale's end and its sold or held count, both editable.
  - Promo codes: "Coupon public" with a name, "Copier le lien du coupon", and a switch between public and private.
  - Run 72's early-access codes are now titled "Accès anticipé (codes de prévente)".
- Tests:
  - `test/payments/presale-coupons.test.ts` and `test/api/home-deals.test.ts`;
  - the Run 97 case in `test/api/home.test.ts`;
  - `test/ui/presale-ui.test.ts` and `test/ui/presale-ops.test.ts`.
- Merged 2939a27 (PR #92). Festival passes followed in Run 98.


## Run 96 — what still stops Havana's sale, verified live (2026-10-22)

- Live on 2026-10-22:
  - `/health` build `26a48ec`, `/health/ready` schema current;
  - `check:golive --url https://alkao.ca`: only warnings, Stripe TEST mode and `/metrics` off.
- Codex (2026-10-21) did the following:
  - provisioned Havana;
  - imported Halloween as drafts: 24 and 31 Oct, 3,000 seats each;
  - saved appearance, refund policy and return origin;
  - set Promo Havana's three ALKAO variables.
- Still blocking, owner only:
  - live `sk_live_` key for the TAKATAK platform (Codex's Stripe connector reaches another account, "ALKAO.CA");
  - live Connect webhook secret;
  - a valid Resend key (the current one returns 400);
  - Havana's Stripe onboarding in /ops.
  Then a paid child ticket, e-mail, QR scan and refund, and only then publish.
- `alkao.ca/` answers 302 to `https://promohavana.ca/billets`. That is `ALKAO_HOME_URL` on the ALKAO Coolify resource, not code. The owner calls it a bug: the operator removes it and restarts. `checkLive` now warns on a home redirect (`src/ops/golive.ts`, test in `test/ops/golive.test.ts`).
- The owner ended Weezevent on 2026-10-22: "ENLEVE WEEZEVENT C FINI". Promo Havana PR #29 takes every Weezevent link out. It is merged (`4e38f98`) but not deployed, and was merged with its `qa` check red: the job never got a runner, like `main` since 16 October. Its 242 local tests pass, and the 2 failures already on `main` remain. Until ALKAO publishes, buy buttons lead to the read-only `/billets` preview.
- NEXT EXACT ACTION, for the operator agent with Coolify access:
  - remove `ALKAO_HOME_URL`;
  - after the owner's keys, redeploy ALKAO, then publish the two sessions once the test purchase passes;
  - redeploy Promo Havana.
  The owner's steps are the table at the top of `docs/CE_SOIR_HAVANA.md`.


## Run 95 — the owner chose B: everything on ALKAO (2026-10-20)

- `docs/CE_SOIR_HAVANA.md` now follows choice B, in this order:
  1. ALKAO goes live and a test purchase succeeds;
  2. the import runs with a cautious capacity;
  3. Promo Havana gets its three ALKAO variables. It switches on its own once ALKAO has sellable dates (`resolvePublicTicketing` in promohavanaca), so the sale never stops;
  4. Weezevent closes the same day;
  5. each Saturday's capacity is raised in /ops to the real capacity minus that Saturday's Weezevent sales.
- At the gate, the tickets already sold on Weezevent stay valid. They are scanned with Weezevent's app; ALKAO tickets with /ops Scanner.
- Refund policy: Havana publishes none for Halloween. A proposed text is in step 6, waiting for the owner's approval.
- Still missing from the owner: the real capacity per evening, and approval of the policy.
- NEXT EXACT ACTION: the operator and owner follow `docs/CE_SOIR_HAVANA.md` before Friday 23 October. No code change is needed.


## Run 94 — Havana's Halloween page, ready to load, and the owner's go-live list (2026-10-18)

- Branch `claude/amazing-pascal-tppqd4`. The owner wants Havana live on alkao.ca tonight.
- `catalogs/havana-halloween-2026.json` now carries the full Run 93 page, taken only from promohavana.ca and havanaresort.ca:
  - format, summary and the notice;
  - 5 highlights, 6 gallery photos (`https://www.promohavana.ca/photos/…`), 4 steps;
  - 6 FAQ answers;
  - what each ticket includes.
  No price, date, capacity or refund policy was invented: capacity is still `--capacity`, and the policy is the owner's to write in Apparence.
- `events:import --update-page` (`src/ops/events-import.ts`): on an event already there, it takes the texts, photo, facts, page and ticket descriptions from the file, with audit rows. It never touches dates, prices or status. Without the flag, a kept event is left as /ops made it.
- `docs/CE_SOIR_HAVANA.md`: the owner's checklist (who, where, exact values):
  - the decision: Weezevent keeps selling with a separate ALKAO quota (A), or everything moves to ALKAO (B);
  - Coolify env and redeploy, the Stripe Connect webhook, `control:apply`;
  - Havana's Stripe, the import, Apparence, `check:golive` and a real test purchase.
  `docs/HAVANA_SUR_ALKAO.md` points to it.
- Live check on 2026-10-18 (`check:golive`): alkao.ca answers on an old build, Stripe is not configured, and Havana is not provisioned. promohavana.ca still sells with Weezevent.
- Test: the Run 94 test in `test/ops/events-import.test.ts`.
- NEXT EXACT ACTION: merge the Run 94 PR when green. The owner and the Coolify operator follow `docs/CE_SOIR_HAVANA.md`. Nobody without server access can make it live.


## Run 93 — the event page in full, on the model of the big ticketing sites (2026-10-18)

- Branch `claude/amazing-pascal-tppqd4`. The owner sent the Fever page of a Montréal exhibition as the reference. ALKAO keeps its own look and invents nothing: no stars or reviews, no booking fees, no discount badges, and urgency only when true.
- 93a, data:
  - Migration `20261110000100_alkao_event_page.sql` adds to `ticketing_events`:
    - `duration_minutes`;
    - `format`;
    - `page jsonb`, holding summary, notice, highlights, gallery, steps and faq.
  - The API checks it with `EventPage` in `src/contracts/api-v1.ts`: plain text, https photos, counted lists. The database checks it too: bounds, an object, 64 KB.
  - It is public with the event, kept by a duplicate, and accepted by `events:import`.
  - The public event now gives each ticket type's `description`.
- 93b, /ops: "Page de l'événement", under the event's Fiche.
  - Duration, format, summary and notice.
  - The highlights, gallery, steps and FAQ lists, each item with move up, move down and remove.
  - With the assistant on: "Rédiger la page avec l'assistant", via `POST …/events/:id/assistant/page`.
    - It writes the summary, highlights, steps and FAQ from the facts, including the refund policy.
    - It keeps the photos already chosen.
    - The same checks in code apply, plus a ceiling on the number of items.
  - The ticket types table gets "Dire ce qui est inclus", shown under "Plus d'infos".
- 93c, shop (`shop-ui/`):
  - Hero: dates as a range, the address, the facts (duration, format, summary, age, language), and a "Réserver" price card.
  - Section tabs that stay in view and follow the reading.
  - Points forts as a rail; Galerie as a mosaic opening the viewer, now with previous and next; Le jour J as a timeline; the notice under the description.
  - The venue with its Google map, loaded only when the buyer asks: `frame-src https://www.google.com` on the shop only.
  - The FAQ: the organizer's questions, then answers from the page's own facts.
  - A calendar replaces the date strip: months, days, then the hours of the day. Door sales keep the hours of the day.
  - The Continue button shows the total.
  - The Brand's rail is now "Vous aimerez aussi".
- Tests:
  - `test/api/event-page.test.ts`;
  - the Run 93 test in `test/ui/shop-ui.test.ts`, whose `pick()` helper goes month, then day, then hour;
  - in `test/ai/assistant.test.ts` and `test/ui/assistant-ui.test.ts`, the page editor and its draft;
  - axe covers the calendar.
- NEXT EXACT ACTION: merge the Run 93 PR when green. The owner fills Havana's page in /ops (photos, highlights, FAQ). Coolify #84 still blocks every deploy.

## Run 92 — executive pass: firm copy, /ops overview, writing assistant (2026-10-17)

- Branch `claude/amazing-pascal-tppqd4` → PR #86. Three parts:
  - 92a, home: firmer, factual copy (FR/EN) and a calm design (no glows, gradient text, pulses or blobs). The "Assistant ALKAO" on the home stays, with no fake typing.
  - 92b, /ops: the dashboard as an executive overview (`ops-ui/app.js`). Front only. It shows:
    - six KPI tiles, with a comparison to the period just before;
    - a daily net sales chart (SVG, with a data table);
    - the brut-to-net statement;
    - the next sessions with sold / held / free bars;
    - the ticket mix, by code: `/reports/sales` has no ticket type names.
    - The tables and CSV exports are kept under "Détail des ventes".
  - 92c, /ops: writing assistant. It drafts a campaign (e-mail or text) or an event description from the Brand's catalog.
- 92c, assistant:
  - `src/ai/writer.ts` calls Claude through `@anthropic-ai/sdk`, pinned at 0.131.0. Settings: structured output, effort `low`, `fallbacks: "default"`.
  - `src/ai/drafts.ts` builds the facts from the catalog, holds the rules, and checks every answer in code. A draft is refused for a price, a percentage, a discount or a code absent from the catalog or the brief, for a link, or for an unknown placeholder. After a refusal there is one retry, then staff get the reasons (422 `assistant_draft_rejected`).
  - No buyer or customer data is sent.
  - Routes: `POST …/assistant/campaign` and `POST …/events/:id/assistant/description`.
  - Daily ceiling per Brand: `ALKAO_ASSISTANT_DAILY_LIMIT`, counted from Journal rows `assistant.drafted`.
  - `GET …/status` returns `assistant: true|false`.
- Assistant flags: OFF by default. It needs `ALKAO_ASSISTANT_ENABLED=true` and `ANTHROPIC_API_KEY` on the server (the owner types the key). The service is paid per use; the cost table is in `docs/ASSISTANT_REDACTION.md`. `check:secrets` now also catches Anthropic keys.
- Tests: `test/ai/assistant.test.ts` and `test/ui/assistant-ui.test.ts`. They use a fake model (`test/helpers/writer.ts`) and never reach the network.
- NEXT EXACT ACTION: merge the Run 92 PR when green. Then the owner decides whether to turn the assistant on (`docs/ASSISTANT_REDACTION.md`). Coolify #84 still blocks every deploy.

## Runs 90–91 — premium buyer pages and Havana's events on alkao.ca (2026-10-17)

- Branch `claude/amazing-pascal-tppqd4` → PR #85. Front only for Run 90: no migration, no server logic, no new dependency.
  - 90a `shop-ui/`: event page as a ticket center (photo hero with zoom, sticky ticket panel, live quote, total bar, other events rail), brand list, checkout, thanks and resume screens.
  - 90b `buyer-ui/`: ticket wallet (carousel of ticket cards, full-screen gate view with Screen Wake Lock, print, offline cache v2).
  - 90c: venue pages in the home's look, compact home filter menus, full-screen photo viewer (`home-ui/home.js`), e-mail landing pages restyled (`src/api/simple-page.ts`). The shop and tickets CSP gained `font-src 'self'`.
- Run 91: `npm run events:import` (`src/ops/events-import.ts`, `scripts/events-import.ts`) loads one event from a file. `catalogs/havana-halloween-2026.json` holds Havana's owner-approved Halloween catalog (adult 25 $, child 5+ 12 $, Saturdays 14 h–22 h). Capacity is never guessed: `--capacity`. Owner steps in French: `docs/HAVANA_SUR_ALKAO.md`.
- Why Havana is not on alkao.ca: the live service has no opted-in Brand, and Havana was never provisioned in production ALKAO. Promo Havana has no `ALKAO_CLIENT_ID`/`ALKAO_BRAND_ID`, and the public API answers 404. This needs the operator (Coolify #84, `control:apply`, Stripe), then one `events:import`.
- Local QA: 88 files, 625 tests before Run 91, plus 6 for the import. `test/ui/offline-cross-tab.test.ts` needs `ALKAO_CHROMIUM_PATH=/opt/pw-browsers/chromium` in cloud containers.
- NEXT EXACT ACTION: merge PR #85 when green; operator follows `docs/HAVANA_SUR_ALKAO.md`.

## Run 89 — degraded incident archive must not blank the scanner (2026-10-16)

- Repo `takatakca/Alkao.ca`, branch `main`. Previous functional SHA `427668f7f2a5700e25b294976d0c011bc9aafe28` passed CI 38960997547 and Package 38960997727. Run 88 documentation commit `e9fe3e76a943cb1f78b9e48ed49556d24f87b8ff`; its CI was cancelled when Run 89 began, Package 38961620983 succeeded. Strict Verify deployment 38961326402 for Run 88 source **FAILURE**: live Coolify did not attest matching build SHA.
- Run 89 worklog claim `6ae3b48f5c6e14dd1d03e39c2c84d564f6e27d6d`. Functional code SHA `8b06cf8368d3a639f607d64a52610ff545fcc04f`. Files: `ops-ui/offline.js` catches failed/corrupt local incident-report archival during automatic 24-hour post-close cleanup and retains original local audit with `incidentArchiveFailed=true`; `ops-ui/app.js` displays an accessible, explicit red warning; `test/ops/offline-incidents.test.ts` checks that expired audit remains available and archiving resumes after storage recovery.
- Run 89 source `8b06cf8368d3a639f607d64a52610ff545fcc04f` passed **CI SUCCESS** 38962087021 (TypeScript, migrations, secrets, full tests) and **Package SUCCESS** 38962086850. Docs-only follow-up SHA has its own CI/Package. This is a client-only safety fix; no DB migration, customer secret, production environment variable or feature switch changed.
- Live deployment remains UNVERIFIED. Issue #84: Coolify operator must attest source SHA at `/health`, dedicated ALKAO DB and backup, authorized migrations, rotated secrets, provider Resend/Stripe and field scanner pilot. Preserve Promo Havana PR #53. Global/Brand ticket transfer switches remain default OFF.
- NEXT EXACT ACTION: verify main HEAD and Run 89 GitHub Actions; fix failures; test real offline devices and corrupted localStorage recovery; confirm Coolify/DB and release only with authorized operator. No external agent restart orchestrator was configured.


## Run 88 — durable offline reconciliation incident ledger (2026-10-16)

- Repo `takatakca/Alkao.ca`, branch `main`. Starting source/head `afa7f7f6860db42ab8f45d6010372383c48bc577`: CI 38958567201 **SUCCESS**, Package 38958567344 **SUCCESS**; strict Verify deployment 38958883411 **FAILURE** (live build SHA not attested). Separate Havana PR #53 remains active.
- Run 88 claim `8d6bd905926bff00778f666f3a2a1c2f3bcaff0a`. Feature commit `e0dbc920cbae98e2d79a19ffd3d3ae22f7957091` adds a client-side, per-session incident ledger: `ops-ui/offline.js` records sanitized credential IDs, server outcomes, dates and historical counts (never a full QR secret), offers CSV generation and archives confirmed discrepancies before mode exit; `ops-ui/app.js` displays a local incident panel and CSV export after exit. `test/ops/offline-incidents.test.ts` exercises conflicts, sanitization, legacy counts, corrupt/quota-failed storage and invalid acknowledgments; `test/ui/offline-cross-tab.test.ts` verifies real Chromium persistence across tabs/reload.
- Initial CI 38960644810 failed ONLY test TypeScript TS7016 on a multiline browser JS import; no migration or security scan ran. Follow-on commit `427668f7f2a5700e25b294976d0c011bc9aafe28` corrects the import and safeguards the 24-hour post-close automatic cleanup: archive unresolved discrepancies before deleting temporary manifest, or preserve it if local storage refuses the archival write.
- Run 88 source `427668f7f2a5700e25b294976d0c011bc9aafe28` passed full CI **SUCCESS** 38960997547 (TypeScript, migrations, secrets, unit and Chromium tests), Package **SUCCESS** 38960997727. A docs-only commit will trigger separate workflow runs. Source files `ops-ui/offline.js`, `ops-ui/app.js`, `test/ops/offline-incidents.test.ts`, `test/ui/offline-cross-tab.test.ts`; no database migration, payment/worker environment variable or production flags touched.
- **Deployment still UNVERIFIED.** Coolify issue #84: authorized operator must verify separate ALKAO DB, backups, migrations, key rotation, `SOURCE_COMMIT` in build, current `/health` SHA, readiness, Resend/Stripe and physical scanner pilots. Both transfer release flags OFF. No Coolify access or external restart orchestrator was confirmed.
- Exact next: inspect current main + newest CI/Package; resolve test failures; field-test iOS/Android devices, multi-gate reconciliation and discrepancy triage with real operator; obtain authorized Coolify backup/migration/release evidence. Preserve PR #53 without interference.


## Run 87 — multi-tab offline scan storage locks (2026-10-16)

- First Chromium test run 38957592844: TypeScript, migrations, secrets and 606/607 tests passed; one browser test failed because Vitest rewrote a dynamic import inside `page.evaluate`. Commit `fa9153282e643700de8ee15ff998774be147121c` fixes the test harness by loading the browser module in its actual HTML page. Replacement source CI **SUCCESS** 38958090144 and Package **SUCCESS** 38958090354 for `fa9153282e643700de8ee15ff998774be147121c`. Verify deployment 38958356323 queued separately and is not proof of production yet. The docs follow-up commit will have new CI/Package runs.


- Run 87 original source `cb184a49` passed CI 38956850284 and Package 38956850276. Added true Chromium two-tab Playwright integration `test/ui/offline-cross-tab.test.ts` in `6032a5303a2a7b79387da0da7e75a6c7a9b9c4bd`; initial CI 38957273249 failed ONLY new test TypeScript browser-module paths/types. Fixes `afb08df7d2543ef53cadc06d1cf1b56ce5f43157` and `88ae7715e9c7a25745558b73e4bbd02d88249c4f` use runtime module import and `globalThis` for browser types. Verify revised CI 38957592844 and Package 38957592600 before marking browser test passed.


- Repo `takatakca/Alkao.ca`, publication branch `main`. Previous Run 86 final source `9fbd33a85c2c2ec04d92bdb56bdc88d6892fb1cb`: CI 38955598793 SUCCESS, Package 38955598811 SUCCESS. Run 86 handoff commit `706425134fbb9780085bd50aa003bd568c731133` followed. Strict live Verify deployment for Run 86 source 38955922348 FAILED; `https://alkao.ca/health` did not attest the build SHA.
- Run 87 claimed by WORKLOG commit `5378e8cab0bf5b2cfcd17cb8cd1eaf863e67f84a`. Functional source commit `cb184a497470be50eed7a2e9aaf1cd5f47ce0517`. Files `ops-ui/offline.js`: new `withOfflineSessionLock(sessionId, operation, {recovery})`, acquiring the origin-scoped browser Web Lock `alkao.ops.offline.audit.<sessionId>` over the full async operation. `ops-ui/app.js`: wraps the previous same-tab FIFO in the shared Web Lock on scan, goOffline, sync and exit; if Web Locks unavailable, no NEW offline admission is allowed and staff see an online-scanner instruction; existing audit uploads and safe exit can use `recovery:true` to avoid trapping previously admitted guests. `test/ops/offline-cross-tab.test.ts`: two-tab delayed batch, unsupported browser, error-release and separate-session tests.
- Run 87 source verification: check GitHub CI run 38956850284, Package run 38956850276 and strict verifier 38956859446 for the latest result. At draft time CI and Package were in progress. Record failures truthfully and repair before claiming success. No DB migration, provider credential or feature flag changes.
- Production remains **UNVERIFIED**. Coolify issue #84: authenticated operator must verify isolated ALKAO DB, backup/restore, existing migrations, secret rotation and SOURCE_COMMIT in build, then compare live `/health` SHA and readiness with main and test Stripe/Resend + real gate scanners. Keep global and Brand transfer options OFF.
- Remaining risk: Web Locks coordinate tabs within one origin/browser profile, not separate physical gates, browsers or storage partitions. With no Web Locks, only already-stored offline admission reconciliation is allowed, not new offline admission; test real iOS/Android and embedded contexts.
- Next action: inspect latest `main`, Run 87 GitHub Actions and correct errors. Perform real Chromium/physical two-tab/terminal tests with delayed HTTP, validate multi-device scan conflicts, then operator-approved Coolify release. Preserve unrelated Promo Havana PR #53. External agent restart orchestrator unavailable.


## Run 86 — serialize same-tab offline scan, sync and exit (2026-10-16)

- Run 86 follow-up commit `9fbd33a85c2c2ec04d92bdb56bdc88d6892fb1cb` adds explicit callback types to `test/ops/offline-concurrency.test.ts` after initial CI 38955194282 failed only TS7006 on two implicit-any test callbacks. Package 38955598811 SUCCESS; revised CI 38955598793 SUCCESS (TypeScript, migrations, secrets, full tests). Strict Verify deployment 38955922348 was still running during handoff; prior live 38945162509 FAILED.


- Repository `takatakca/Alkao.ca`, branch `main`. Previous verified docs SHA `8634ea75fd871ba21a8480ca80d05fb3ba7fd68a`: CI 38944905867 SUCCESS, Package 38944905732 SUCCESS. Strict Verify deployment 38945162509 FAILURE: repeated 8 times, live `/health` does not publish build SHA (Coolify "Include Source Commit in Build").
- Run 86 claim `08ffba02cae920b2f7dc7241e2e9e53075fc8cc2`, source commit `29a5f8f213fc788653bd933d709c39fe1cae150b`. Files: `ops-ui/offline.js` new `createOfflineCoordinator` FIFO; `ops-ui/app.js` uses same per-tab FIFO for entering offline mode, background/manual synchronization, scan and exit, prevents concurrent stale read/write of localStorage, rejects local persistence failure with a "DO NOT ADMIT" instruction, never resets existing audit queue; `test/ops/offline-concurrency.test.ts` covers late HTTP acknowledgment vs new admission, premature exit and recovery after failed operation. No migration, live feature flag, customer data or provider secret changes.
- Verification: inspect CI 38955194282 and Package 38955194286 for latest source; Package was SUCCESS while CI installed Chromium when docs drafted. Do not declare code green before CI completes; fix actual errors if any. Documentation-only follow-up will start independent workflows.
- Deployment: unverified. Issue #84: authorized Coolify operator must prove dedicated ALKAO DB and backup, apply pending migrations, rotate previously leaked secrets, enable source commit in build, and attest exact live SHA and readiness; verify Stripe/Resend/multi-device offline scanning. Keep `ALKAO_TRANSFER_API_ENABLED=false` and Brand transfer opt-in OFF.
- Known limitation: FIFO prevents races in one Operations scanner tab. Multiple tabs/windows sharing the same browser profile or storage eviction/failure still require separate field/device safeguards. UI must reject unsaved admissions; no claim of cross-tab atomic storage.
- Next exact action: check source CI/Package and the new docs SHA; investigate any failing browser test; separately test cross-tab kiosk/device and degraded local storage, live Coolify authentication and SHA, then approved release. Do not touch active Promo Havana PR #53. External session restart orchestrator is not configured.


## Run 85 — prevent data loss on offline scanner exit (2026-10-16)

- Repository `takatakca/Alkao.ca`, `main`. Previous Run 84 source code `21a7031cde9ef7da4ca7077b7ab015bad00022c1` passed CI 38942936131 and Package 38942935861; Run 84 handoff commit `10b89922aef24802b1e1009e3fa17cb2b17cad5b`. Strict live Verify deployment for previous source failed again (GitHub Actions 38943283468), so no Coolify attestation.
- Run 85 worklog claim `e71b08ada6e292461680d60a2e3ce5fb43ecb251`, functional commit `62aedcd5f8b4d75644162eead67267b2be2ec69e`. Changed `ops-ui/app.js` and `test/ui/ops-ui.test.ts`. Operator cannot leave offline mode when physically admitted ticket scans remain unacknowledged: the old destructive confirmation dialog is gone. Instead display actionable error requiring reconnection + successful synchronization, keeping local queue and offline mode intact. Browser integration test purchases ticket, admits it offline, attempts to exit while disconnected (queue preserved), reconnects/synchronizes and exits with server admission persisted.
- QA source SHA `62aedcd5f8b4d75644162eead67267b2be2ec69e`: full CI **SUCCESS** 38944264243 (typecheck, migrations, secrets, integration/browser tests), Package **SUCCESS** 38944264279. A documentation-only commit will follow and trigger independent checks. No migration or production flag changes in Run 85.
- Deployment stays UNVERIFIED. Coolify production `/health` does not show build commit; issue #84 demands enabling Include Source Commit in Build, dedicating/snapshotting ALKAO DB, applying authorized migrations, rotating historically exposed credentials and proving provider/scanner workflows. Keep `ALKAO_TRANSFER_API_ENABLED=false` and per-Brand opt-in OFF until evidence.
- NEXT exact action: confirm SHA and CI/Package result; fix any browser regression; examine production verifier output, then use authorized Coolify access when available to deploy and prove live build SHA and readiness. Further P1: real device multi-gate/offline conflict pilot; retain unrelated PR #53 as separate agent work. No automatic session-restart orchestrator connected.


## Run 84 — offline gate queue and lossless reconciliation (2026-10-16)

- Repo: `takatakca/Alkao.ca`, branch `main`. Previous confirmed HEAD `3b5846a4b534d4dd162f3a00be23add0ebfc4b5f`: CI 38885842348 **SUCCESS**, Package 38885842312 **SUCCESS**; strict Verify deployment 38886146185 **FAILURE**.
- Run 84 worklog claimed at `f594d7e9833de65a4de34944c47581f886954ea6`, code commits `faf44749151a3614748d1dce1eb88a6546632190` and `21a7031cde9ef7da4ca7077b7ab015bad00022c1` (adapted existing UI and cryptographic regression tests) (check final current SHA). Changed `ops-ui/offline.js`, `ops-ui/app.js`, `test/ops/offline.test.ts`, `test/ops/offline-signature.test.ts`; added `test/ops/offline-reconciliation.test.ts`, and `test/ui/ops-ui.test.ts`.
- Fix: offline scanner now enqueues ONLY locally authenticated/admitted QR. Malformed, unsupported Ed25519, expired manifest and all other locally denied attempts cannot be replayed by the server as unattended admissions. Legacy persisted queues with no `admittedOffline: true` are filtered without submission. `syncOffline` retains the whole admission batch on HTTP errors, malformed/partial acknowledgment, bad index or unknown result; it removes entries only after all 500-or-fewer indexed results are recognized. Any locally admitted QR rejected online (already_admitted/revoked/etc.) increments an incident counter with generic wording rather than asserting another gate was responsible. New unit tests cover two gates, revoked transferred QR, bad HTTP 403, incomplete results, 501 entries and stale queued denials.
- Source code CI **SUCCESS** run 38942936131 (typecheck, migrations, secrets, all tests) and Package **SUCCESS** run 38942935861 for `21a7031cde9ef7da4ca7077b7ab015bad00022c1`. A documentation-only commit will advance HEAD and get independent checks. No migration in Run 84. Production transfer flags still default OFF.
- Deployment: live strict Verify deployment `38886146185` FAILED on previous SHA: logs explicitly say `le serveur ne publie pas le SHA du build (Include source commit in build)` on eight attempts. Issue #84 requires Coolify include source commit, clean dedicated ALKAO DB, backup, migrations, secret rotation, live Stripe/Resend/scanner acceptance; do not infer deployment from `Live` SUCCESS. No production deployment performed.
- NEXT exact action: confirm current CI/Package; repair failures; check current live `/health` SHA and `/health/ready`; coordinate authorized Coolify configuration and DB backup/migration. Independently run real mobile/browser two-gate acceptance and network-loss QA. Do not touch unrelated Promo Havana PR #53. External session orchestrator is not connected.


## Run 83 — fail-closed offline QR signature check (2026-10-16)

- Repo `takatakca/Alkao.ca`, `main`. Prior Run 82 functional SHA `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63` passed CI 38884229198 and Package 38884229102. Run 82 handoff commit `217c01b27f62cd4bda056910e705a3cba21f0d68` preserved.
- Latest Run 83 source SHA `7b004ba2b408d3e0f65ed710927f6c3684503a66`. Modified `ops-ui/offline.js`: a manifest ID match can NEVER compensate for unverified Ed25519 signature. Missing WebCrypto or unsupported Ed25519 returns `signature_unavailable` and does not admit the ticket. Invalid cryptographic signatures return `invalid_signature`. `ops-ui/app.js` instructs staff to switch to online verification instead of admitting without proof.
- New `test/ops/offline-signature.test.ts` covers no WebCrypto, unsupported Ed25519, forged QR, authentic signed QR, revocation on refreshed manifest, and manifest expiry. Tests intentionally use local Node Ed25519 key pairs, not secrets or customer QR.
- Source CI **SUCCESS** 38885296988, Package **SUCCESS** 38885297040 for code SHA `7b004ba2b408d3e0f65ed710927f6c3684503a66`. The documentation commit will advance main and trigger its own CI; a green package does not attest Coolify. No database migration in Run 83, no change to buyer or payment API or Brand data.
- Production is NOT verified. Prior live strict deployment verifier failed to match `/health` build SHA; issue #84 requires Coolify source SHA, dedicated database, backups, migrations, historical secret rotation, Stripe/Resend, and pilot scanner verification. Transfers remain default OFF globally and by Brand. PR #53 belongs to a separate Havana branch.
- NEXT: verify newest `main`, CI/Package and live strict check; fix any test/browser errors. Test actual mobile browser online fallback, multiple offline gates and manifest refresh; then authorized Coolify go-live. No agent restart orchestrator exists.


## Run 82 — cancellation window transfer safety (2026-10-16)

- Repository `takatakca/Alkao.ca`, `main`. Previous Run 81 source `1debe096c9c8ad5421b7c39b1efe68ff744df8d6` passed CI 38883239557 and Package 38883239522. Run 81 docs commit `2529d343dbeb2c0a9abfa0c8a874a0d93ed7c8be` remains in history.
- Run 82 code commit `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63`: `src/ops/transfer-request.ts` locks session FOR SHARE and refuses new invitations after cancellation, `src/ops/transfer-acceptance.ts` locks and checks session while recipient claims, `src/api/http.ts` maps organizer cancellation to 409, new `supabase/migrations/20261109000100_alkao_transfer_cancelled_sessions.sql` enforces insert-time check with session row lock, and `test/db/transfer-cancelled-session.test.ts` verifies pending claim rejection/QR not rotated, new request and SQL bypass rejected, and no email after cancellation.
- QA confirmed for `7f5e7d135f35a59e9ac7e5f9d376a3f327992f63`: CI SUCCESS 38884229198 (TypeScript, migrations, secrets, full tests), Package SUCCESS 38884229102. Docs-only follow-up commit will trigger its own checks.
- Production: still NOT VERIFIED. Coolify strict live SHA checks failed in prior runs; no operator access or secrets were assumed. `ALKAO_TRANSFER_API_ENABLED` and Brand transfer switches remain default OFF. Issue #84 still requires dedicated DB verification, backup, migrations, historical secret rotation, provider tests and current build SHA attestation.
- Next action: verify newest `main` and CI; correct any Run 82 failures; continue offline manifest/chargeback race tests or operator-approved Coolify deployment. Never deploy migrations against an unconfirmed shared DB, do not touch PR #53. No automatic agent restart configured.


## Run 81 — payment dispute/refund hardening (2026-10-16)

- Repository: `takatakca/Alkao.ca`, branch `main`. Previous main `e084ca7cd231cd9ffd6c885547a8ee01a92a1187`: CI 38855328040 SUCCESS; Package 38855327968 SUCCESS; strict Verify deployment 38855537560 FAILURE.
- Run 81 functional commits `7b19da340072c7c11db2049991e97e79c3fa56c9` and `1debe096c9c8ad5421b7c39b1efe68ff744df8d6`. New `src/ops/transfer-payment.ts` checks pending order refunds and disputes other than won/warning_closed/prevented. `src/ops/transfer-request.ts` locks order before ticket and blocks unsafe invitations; `src/ops/transfer-acceptance.ts` checks the same boundary after the order lock before QR rotation.
- `supabase/migrations/20261108000100_alkao_transfer_payment_guards.sql` replaces the private trigger to reject direct DB transfer creation under unsettled payments. `src/delivery/transfer-invitations.ts` defers delivery by 15 minutes without exhausting provider attempts, then sends after resolution or skips on expiry. `src/api/http.ts` maps initiation refusal to HTTP 409 without PII. `test/db/transfer-payment.test.ts` tests pending refund, direct DB write protection, no QR reissue, open/lost/won disputes, and real queued email deferred/resumed once.
- Run 81 verified source SHA `1debe096c9c8ad5421b7c39b1efe68ff744df8d6`: CI **SUCCESS** run 38883239557 (typecheck, check:migrations, check:secrets, full tests), Package **SUCCESS** 38883239522. CI for this documentation-only commit will have its own run. Strict live verification is distinct.
- No deployment or customer release authorized. `ALKAO_TRANSFER_API_ENABLED` remains OFF by default, Brands OFF by default. Latest strict production deployment evidence FAILED: no matching Coolify `/health` SHA. Issue #84 requires authorized operator to confirm separate ALKAO DB, backups, migrations, leak rotation, workers, Resend/Stripe tests and SHA.
- Next exact action: check latest CI and Package on the current main SHA; correct any failing tests; validate full refund + chargeback / cancellation and offline device races before real pilot. Re-verify Coolify and migrate ONLY after operator confirms target DB and backup. Keep PR #53 separate. No automatic agent-session restart configured.


## Run 80 — newest handoff (2026-10-16)

- More code: `f9203cec54a17bcb8d236aef98a55cc529083345` adds `test/ops/transfer-worker-gate.test.ts` (delivery default-off and once-on). `e085b59f83409a37fd6f76d585b7493d6e5f2ef8` fixes a browser selector collision by rendering `non autorisé` for transfer settings and documents `.env.example` default false.


- Repo `takatakca/Alkao.ca`, branch `main`. Source code commits `59e31276b42ff695cadf9e5d90b2221616820fc6`, `d0f11e2107f324167c7535a6ed497ceaabec30d9`, `fe6abc324b93a2c6a8b4162c3d7413da8282f893`. Documentation commit may advance main: re-read live HEAD before edits.
- Last task: Run 80, guarded transfer UX/APIs. API modules `src/api/app.ts`, `src/api/buyer-ui.ts`, `src/api/http.ts`, `src/config.ts`, `src/server.ts`; ops `src/ops/exchange.ts`, `src/ops/transfer-request.ts`; delivery `src/delivery/transfer-invitations.ts`, `src/delivery/worker.ts`, `src/ops/cron.ts`, `scripts/email-worker.ts`, `scripts/cron.ts`; UIs `buyer-ui/app.js`, `buyer-ui/styles.css`, `buyer-ui/transfer.html`, `buyer-ui/transfer.js`, `buyer-ui/transfer.css`, `ops-ui/app.js`; tests `test/api/transfers.test.ts`, `test/api/transfer-settings.test.ts`, `test/api/config.test.ts`, `test/ui/transfer-ui.test.ts`.
- Public endpoints are protected by tenant's operational gate, `ALKAO_TRANSFER_API_ENABLED` (default false), independent Brand opt-in (default false), scoped order or recipient proof, optional expiry and basic in-process rate limits. No recipient claim secret is returned to sender. Buyer email invitation delivered by Resend only once feature enabled on email worker and API, and once queue is eligible; recipient confirms and receives a unique separate QR access token. Owner/admin Brand toggle with audit. Sender QR excluded after claim, order session exchange refused.
- First CI on `59e31276` failed test expectation for a well-formed but wrong secret (404 is correct); second CI on `d0f11e21` failed test expectation for wrong tenant (404 correct). Both test assertions were corrected in later commits. Package passed on both. Run 80 full CI **SUCCESS** 38854862144 and Package **SUCCESS** 38854861945 for `e085b59f83409a37fd6f76d585b7493d6e5f2ef8`. Earlier intermediate CIs failed only test expectations and a UI selector collision, both corrected. This docs commit will advance `main` and trigger its own CI.
- Production: **UNVERIFIED**. Prior strict verify runs failed because Coolify live `/health` did not attest the Git SHA; green CI and successful `Live` probes are not a deployment. Issue #84 requires authorized operator for dedicated DB, backup, historical key rotation, migrations and Coolify source SHA. No live feature flag, billing or production DB was changed.
- NEXT exact action: inspect latest `main` SHA, GitHub CI, fix remaining assertions or browser failures if any; verify live source SHA and migrate only under authorized operation; ensure Resend real delivery, refund/chargeback and scanner offline-device safety tests; then and only then enable `ALKAO_TRANSFER_API_ENABLED=true` in API and email/cron worker and opt in a pilot Brand. Continue unrelated backlog independently. Do not touch unrelated PR #53.
- Automatic session restart/orchestrator was not configured; Actions CI and Live checks are validation jobs only.


## Run 79 — validated internal QR transfer (2026-10-15)

- Source code/main `a4994017953ed437bcfee50d740195949d9917fd`. GitHub CI 38736545944 SUCCESS (typecheck, migrations, secrets, all tests); Package 38736546000 SUCCESS.
- Run 79 initial implementation `99f94e3582b3e8c063fdadf5c0d62e090fe296f1`, corrected a tenant-scoped FK and offline scanner stale-manifest handling in `a4994017`. All new acceptance tests passed before and after the fix.
- New migration: `supabase/migrations/20261107000100_alkao_transfer_acceptance.sql`. New service: `src/ops/transfer-acceptance.ts`; changed `src/delivery/transfer-token.ts`, `src/db/credentials.ts`, `src/scanner/service.ts`, `ops-ui/offline.js`, `ops-ui/app.js`, `test/db/rls.test.ts`; tests `test/db/transfer-acceptance.test.ts` and `test/ops/offline.test.ts`.
- The recipient claim service (INTERNAL ONLY) requires scoped claim secret, live paid and unscanned ticket, brand opt-in and request expiry. Claim locks the order/ticket and atomically revokes old QR, issues fresh credential and records one accepted transfer. The original order QR read excludes transferred tickets. Online scan rechecks revocation after ticket lock. Offline scanners reject expired/missing manifest validity rather than accepting stale QR.
- Buyer-facing initiation, recipient claim page, publicly accessible recipient ticket page, signed invitation auto-delivery and full refund/browser/device E2E are NOT finished. The sender is NOT wired to the production email worker. No public transfer button is available.
- Latest strict deployment verification 38736880991 started after CI; inspect its final result. Historical checks failed because Coolify did not expose the running source SHA. Site availability is not deployment proof. Dedicated ALKAO DB, migrations, old key rotation and Coolify access remain with authorized operator, issue #84; do not change unknown production DB.
- Next exact action: inspect main SHA / latest Actions, finish gated public initiation + cancellation + recipient claim/QR routes, responsive FR/EN buyer/recipient UI, enable email delivery only after real E2E tests; confirm scanner freshness, refunds and live Coolify SHA. No autonomous agent-session restart exists.


## Run 78 — verified source and exact continuation (2026-10-15)

- Current repository `takatakca/Alkao.ca`, main. Functional source SHA `e3b1777434f72db73110d1c0889e1af84c8adff2`.
- CI run 38734506526 SUCCESS: TypeScript, migration checker, secret guard and all tests; Package 38734506570 SUCCESS. Do not mistake packaging for deployment.
- Added `src/delivery/transfer-token.ts`, `src/delivery/transfer-invitations.ts`, migration `20261106000100_alkao_transfer_invite_delivery.sql`, test `test/delivery/transfer-invitations.test.ts`; updated `src/ops/transfer-request.ts`, transfer-service and RLS tests.
- Recipient secret now reproducibly derives from server-only master secret + random request ID, scope, ticket, recipient. Only SHA-256 is retained. Creation transaction enqueues outbox row. Sender has retry, explicit recipient, state/expiry/tenant checks, key-rotation guard and no disclosure in DB.
- **Not live:** new sender is NOT registered with the automatic worker. A functional recipient claim endpoint, one-time acceptance, atomic QR rotation and rights/ownership changes, refund interaction, offline scanner verification, and responsive FR/EN buyer experience are all UNFINISHED.
- Last strict production verification 38734266563 FAILED. Site answers its probes but does not expose the current source SHA. Coolify issue #84: authorized operator must confirm separate database, backup, rotate historic leaks, run migrations, configure build SHA and provide health/Stripe test evidence. No production secrets modified.
- Next action: inspect current main SHA and CI; develop recipient-only claim acceptance with new credential, revoke prior QR and prevent sender token access, plus race/refund/offline-manifest tests. Do not send invitations or show a transfer UI before the entire chain is proven.
- Automated agent restart is NOT configured. GitHub Actions validates source and observes release only.


## Run 77 — latest execution checkpoint (2026-10-14)

- Source: `c7864c5757243ad3835ee1c22f71798240c23732`, internal `src/ops/transfer-request.ts` and `test/db/transfer-service.test.ts`, building on migration `0da240f241e8c1eb9e0fbf8d23ba72f6567d3c7b`.
- Private creation/cancellation validates the buyer order token, Client/Brand and ticket in transactions, stores only a hash of the one-time recipient secret, writes a PII-free audit entry. It DOES NOT deliver email, accept claims or change QR ownership.
- CI **SUCCESS** 38631015271 for `c7864c57`; Package **SUCCESS** 38631014226. Earlier Run 77 migration CI/Package also succeeded on `824672fa`.
- Production: NOT verified. Strict deployment check 38631011448 failed; Coolify `/health` does not attest to current source SHA. Issue #84 needs authorized operator for dedicated database, backups, secrets rotation, migrations and actual deployment.
- This docs commit advances main; check fresh HEAD and its CI rather than assuming `c7864c57` is final.
- Next: implement recipient-only verified email invitation; authenticated one-time claim; atomic new ticket + sender QR revocation + audit; tests for scan manifests/offline, concurrency and refunds. No public transfer UI until this is safe. Reference `docs/TRANSFER_PROTOCOL.md`.


## Run 77 — transfer-request safety foundation (October 14, 2026)

- Read `AGENTS.md`, `WORKLOG.md`, all five standard status documents and open PRs.
  PR #53 is a separate Havana release; do not modify its branch.
- Previous main `2fe6bc503d3c9e05f7725cff1069f12cbc89fda3` passed CI
  38627463072 and Package 38627462930. Strict deploy workflow 38627810742
  failed: `alkao.ca` responds but does not publish the expected `build` SHA.
- Claimed Run 77 in `WORKLOG.md` at `a4d87533a445042498980a6ae958743330d2b78c`.
- Code pushed `0da240f241e8c1eb9e0fbf8d23ba72f6567d3c7b`:
  `supabase/migrations/20261105000100_alkao_transfer_requests.sql`,
  `test/db/transfers.test.ts`, `test/db/rls.test.ts`.
- New schema: Brand-specific default-OFF transfer flag, server-private transfer
  intents with hashed claim secret, short expiry, one pending request per ticket,
  immutable history, tenant composite FK and admission/order eligibility guard.
- Scope is **DB foundation only**. There is intentionally no buyer-facing
  transfer button, no claim endpoint, no email or transferred ownership yet.
  Source QR stays valid until a later verified acceptance implementation.
- Code package passed (run 38630063950). Run 77 CI **passed** at commit 0da240f2 (run 38630063783), including
  TypeScript, migrations, secrets, PostgreSQL/RLS tests. Package also passed.
- No local production migration or Coolify deployment performed. Next steps:
  (1) inspect Run 77 CI and fix any concrete SQL/test error;
  (2) check final `main` SHA and strict deployment logs separately;
  (3) implement recipient email verification + atomic ticket reissuance before
      exposing a transfer feature; reference `docs/TRANSFER_PROTOCOL.md`;
  (4) Coolify owner resolves issue #84 (dedicated DB, key rotation, migration,
      source SHA in build and deployment verification). No secrets in GitHub.
- No external autonomous session orchestrator has been verified or connected.


## Run 76 verified

- Main SHA `1035bcf63941990d6e28fc8d632ddbf2b51b23eb`: CI run 38626850981 SUCCESS (typecheck, migration check, secret check, tests), Package run 38626850976 SUCCESS.
- Run 76 implementation commit `d67896fb317dcbaa6ba7aa373e5843b95b5440b8`; documentation commit advanced main, without source-code differences.
- Strict production verification triggered as run 38627287634. Confirm its final logs before marking deployed. Previous strict verification 38624485645 failed: ALKAO replied but published no build SHA.
- Next action: verify Coolify's build SHA and dedicated ALKAO DB, and implement the next P1 ticket-transfer workflow with sender revocation and recipient authorization. Do not mark transfer as complete before its tests pass.


## Run 76 — October 14, 2026

- Code pushed: d67896fb317dcbaa6ba7aa373e5843b95b5440b8.
- Updated src/api/app.ts; added src/api/order-token.ts and test/api/order-token.test.ts.
- Order GET and session exchange now reject expired tokens while retaining existing non-expiring links.
- Package succeeded. Inspect the latest CI before claiming complete validation.
- Production remains unverified: deployment check 38624485645 failed because /health did not expose a build SHA.
- Next: check latest CI, correct any failures, and continue secure ticket transfers without bypassing tenant checks.


Updated: 2026-10-14. Repository: `takatakca/Alkao.ca`, target branch `main`.
Read `AGENTS.md`, `WORKLOG.md` and this file **before** working. Historical agent notes
remain in [TAKATAK_AGENT_HANDOFF.md](TAKATAK_AGENT_HANDOFF.md).

## 2026-10-14 — Run 75 / current continuation

- Previous `main` SHA: `5743ab1d540624a63c2ead00de7addcb7edb3e34`.
  Its GitHub CI and Package both **passed** (Runs 38615140934, 38615141054).
- Claimed Run 75 in `WORKLOG.md` (commit `b73c56af08e35480cba82ccc85b780f3e42ef3a3`).
- Implemented `GET /salles/:clientId/:brandId/:venueId/agenda.ics`,
  bilingual download link, RFC 5545 escaping/folding with stable public event
  UIDs and every currently on-sale session. Direct requests go through the same
  opted-in/entitled per-Brand catalog gate. Unknown, private, white-label and
  withdrawn venues return 404. No payment changes or DB migration.
- Implementation pushed to main: `9a596345de8ede86a3d52cde8d92a006db597ba6`.
  Changes: `src/api/venue-calendar.ts`, `src/api/venue-view.ts`,
  `src/api/home.ts`, `test/api/venue-calendar.test.ts`,
  `test/api/venues.test.ts`, `test/api/gate.test.ts`,
  `.github/workflows/verify-deploy.yml`, `docs/TASK_QUEUE.md`.
- Eliminated misleading success for superseded CI in Verify deployment:
  obsolete verification exits nonzero and explicitly says no release was verified.
- Validation: GitHub Package **passed** for `9a596345`; GitHub CI
  typecheck, migrations and secret guard passed, but its full test suite
  initially failed on three **test assertions**, not implementation: counting
  an escaped title as a VEVENT and expecting unfolded URL lines. Corrected
  both tests in `ce9db10f4f707a694c69914e31f015f8513aef38`.
  Check its CI run https://github.com/takatakca/Alkao.ca/actions/runs/38623785741.
  This documentation commit advances `main` once more, so verify latest CI.
- Production status: not verified. Public site probes were unavailable through
  public web fetch; there is no evidence Coolify has run the latest SHA. Follow
  production issue #84. No secret values have been accessed or modified.
- **Exact next action:** inspect newest main SHA and CI run; if a test failed,
  read the job logs and correct it. If green, inspect strict verification logs
  for an actual SHA match (not a superseded skip). Continue the P1 buyer transfer
  only after designing a genuinely revocable, tenant-safe ownership workflow.

## Latest completed work / current task

- Run 73: FR/EN public venue directory/detail, home links and sitemap. Validated at
  `f339d3eb19a0f4e073ca89f7612c2c0bb5af5765`.
- Run 74: server-rendered venue name/organizer/city search, locale handling, accent
  normalization, strict deployment SHA checks, CI-driven verification workflow.
- Code commit initially pushed: `413f2af9388c5052ce485bd0a0e19ee2c3171291`.
  Subsequent bugfix/tests: `a790c19395a17c4335ec3c4ec648120dc7a30769`,
  locale navigation `7c6313de0af38238060cf74419466fe173187e7c`,
  corresponding test `92a5c08d04987540108b3a2c7bf4790e6b263274`.
  Workflow concurrency fix: `91515fe55ffdc227929854fa37f44d2689910fe9`.
  The handoff documentation commit itself advances main further: read GitHub HEAD
  before any write; never assume the code SHA is the newest ref.
- Verification: CI **passed** for `a790c193`; `Package` **passed** for
  `92a5c08d`. The CI for `92a5c08d` was **queued** at last observation, not
  verified green. Older CI jobs were cancelled under new concurrency policy.
- The first `Verify deployment` workflow labeled successful merely **skipped
  a superseded CI commit**, as confirmed in its logs. This is NOT proof that
  Coolify serves the latest main commit. Next step: inspect the verification
  run for the latest green CI and the actual public `/health` build SHA.
- Current task: monitor newest GitHub CI and deployment verification, fix any
  concrete failures. Continue the next independent backlog item after release
  evidence is recorded.

## Files touched in Run 74

`src/api/venue-view.ts`, `src/api/home.ts`, `home-ui/home.css`,
`test/api/venues.test.ts`, `src/ops/live-watch.ts`, `scripts/live-watch.ts`,
`test/ops/live-watch.test.ts`, `.github/workflows/verify-deploy.yml`,
`src/api/home-view.ts`, `.github/workflows/ci.yml`, `.github/workflows/package.yml`,
`AGENTS.md`, `WORKLOG.md`, these five standard docs, historical handoff and README.

## Checks and commands

- GitHub Actions CI: TypeScript, migration constraints, secret guard, Vitest using
  disposable PostgreSQL and Playwright; `.github/workflows/ci.yml`.
- Package: `.github/workflows/package.yml`, creates a MochaHost artefact; not a deploy.
- Local: `npm ci && npm run typecheck && npm run check:migrations && npm run check:secrets`
  then `npm test` with disposable test PostgreSQL as documented in README.
- Live (availability only): `node --import tsx scripts/live-watch.ts https://alkao.ca`.
- Live (strict release check):
  `node --import tsx scripts/live-watch.ts --require-build --expect-build <40-char-git-sha> https://alkao.ca`.
- CI-driven `Verify deployment`: observes exact source commit after a successful CI
  (skips superseded runs), retries briefly then **fails** if Coolify did not publish SHA.

No external code-agent orchestrator has been connected or verified. GitHub Actions
automatically checks source, packages and observes releases; it does **not** relaunch
this assistant after a chat ends. Do not claim unattended development without
a separately configured and authorized agent runner.

## Known blockers and risks

- Issue #84: production Coolify cannot be confirmed deployed from GitHub alone.
  The last observed public health response lacked `build` even though live checks
  returned healthy. Live GitHub workflow is deliberately advisory for version lag;
  strict deployment workflow rejects absent/mismatched build.
- Historical public `.env.example` leak (`c75f797`): rotate credentials at providers.
  ALKAO must use a **dedicated** database, never TAKATAK/FESTI-ICE master data.
- Coolify needs an operator with permission to inspect database and app settings:
  `ALKAO_MIGRATE_ON_START=true`, `ALKAO_RUN_WORKERS=true`, source commit in image,
  readiness path `/health/ready`, plus server-only credentials.
- No provider secrets or DB URLs in GitHub docs. Do not flip operational sales on
  without the documented go-live and Stripe test purchase.

## Exact next action

1. Check `main` head and the newest GitHub Actions CI/Package/Verify deployment runs.
2. If CI fails, inspect the failing job logs, correct a concrete cause, push and repeat.
3. If CI passes, record actual SHA and separate deployment result; continue the
   next independent ticketing roadmap task in `TASK_QUEUE.md`.
4. An authorized Coolify operator must complete issue #84 before declaring the
   current code live. Keep legacy worklog and handoff intact.
