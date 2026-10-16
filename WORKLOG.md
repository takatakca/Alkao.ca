# Work log

Newest first, one line per piece of work. Rule: `AGENTS.md` › Work log rule.
Format: `YYYY-MM-DD | agent | branch → PR | status | what | next step`

- 2026-10-16 | ChatGPT (GitHub) | main → faf44749, 21a7031c | done in code; CI 38942936131 and Package 38942935861 SUCCESS, production not verified | Run 84: only locally admitted offline QR enters sync queue, prevents unattended entry from rejected scans, preserves unacknowledged batches, counts server-side discrepancies, multi-gate regression suite | next: Coolify #84 SHA/DB/secret release and real multi-device pilot

- 2026-10-16 | ChatGPT (GitHub) | main → 7b004ba2 | done in code; CI 38885296988 and Package 38885297040 SUCCESS; deployment unverified | Run 83: offline scanner fail-closed signature verification on Ed25519-unavailable devices and regression tests for forged QRs | next: test mobile devices and multi-gate offline; Coolify #84

- 2026-10-16 | ChatGPT (GitHub) | main → 7f5e7d135 | done in code, CI 38884229198 + Package 38884229102 SUCCESS; Coolify unverified | Run 82: session-locked transfer creation/acceptance, private DB cancellation guard, QR/mail regression during asynchronous refunds | next: offline scanner/race QA and authorized Coolify #84

- 2026-10-16 | ChatGPT (GitHub) | main → 7b19da34 and 1debe096 | done in code, CI 38883239557 + Package 38883239522 SUCCESS; Coolify not verified | Run 81: order-locked refund/dispute eligibility, PostgreSQL trigger, delayed/retry-safe invitation mail, financial and direct-SQL regression tests | next: live #84 and cancelled-session/refund/offline scanner QA

- 2026-10-16 | ChatGPT (GitHub) | main → 59e31276, d0f11e21, fe6abc32, f9203cec, e085b59f | done in code; CI 38854862144 and Package 38854861945 SUCCESS, Coolify unverified | Run 80: gated transfer APIs, real Resend worker/cron opt-in, FR/EN buyer and recipient UI, one-time claim/new QR, organizer toggle/audit, worker-release/browser tests; global and Brand flags default OFF | next: Coolify SHA/DB/Resend/scanner acceptance #84 and remaining backlog

- 2026-10-15 | ChatGPT (GitHub) | main → 99f94e35 and a4994017 | done in code, CI 38736545944 + Package 38736546000 SUCCESS; Coolify unverified | Run 79: one-time recipient acceptance, atomic QR rotation, sender exclusion, scanner locks, expired offline manifest fail-closed, tenant FK/test fix | next gated public API, FR/EN UI, email activation after E2E, Coolify #84

- 2026-10-15 | ChatGPT (GitHub) | main → e3b17774 | done in code, CI 38734506526 + Package 38734506570 SUCCESS; production unverified | Run 78: private recipient invitation outbox, reconstructible hashed proof, staged retry-safe dispatcher and security tests; NO public claim or QR transfer yet | implement atomic recipient claim, release only after Coolify verification

- 2026-10-14 | ChatGPT (GitHub) | main → direct commits 0da240f2 and c7864c57 | done: DB and private service CI/Package green; Coolify unverified | Run 77: default-off tenant-safe transfer requests and private create/cancel invitations; NO public transfer/claim or QR replacement | next: verified email, atomic claim/QR revocation, tests, Coolify #84

- 2026-10-14 | ChatGPT (GitHub) | main → direct commits | done, CI and Package green at 1035bcf6; Coolify release unverified | Run 76: tenant-scoped expiry enforcement for order GET/exchange POST with tests | verify live SHA, implement secure P1 recipient transfer

- 2026-10-14 | ChatGPT (GitHub) | main → direct commits (9a596345) | blocked: final CI result and Coolify release verification pending | Run 75: public .ics venue calendars, bilingual CTA, tests, strict deployment verification fix, source pushed and Package successful | inspect full CI, fix if needed; verify Coolify SHA before claiming live

- 2026-10-14 | ChatGPT (GitHub) | main → direct commits (92a5c08d) | blocked: latest CI queued on GitHub; Coolify not verified | Run 74: real bilingual venue search, strict SHA-aware deployment monitor, five standard handoff documents, language routing fix; code pushed | read latest Actions, fix failures if any; then operator resolves Coolify #84

- 2026-10-14 | ChatGPT (GitHub) | main → direct commit | done | Run 73: bilingual venue index and venue pages, links from events, SEO sitemap, gated by ALKAO public catalog | deploy after Coolify migrations; check live site and QA

- 2026-10-14 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #83 | review | Run 72: presale codes (buy before the public sale opens) and "La vente ouvre le …" in the shop | merge when green
- 2026-10-14 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #82 | done | Run 71: waitlist for sold-out sessions (shop form, one e-mail when seats come back, /ops count, purge after 30 days) | owner: turn on ALKAO_MIGRATE_ON_START so Runs 69-71 deploy
- 2026-10-14 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #81 | done | Run 70: /health/ready checks the build's migrations are applied (schema current/behind/unknown); live watch reports it | alkao.ca still on the Run 69 build 25 min later: owner turns on ALKAO_MIGRATE_ON_START
- 2026-10-14 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #80 | done | Run 69: structured event data — category, minimum age, doors, language, accessibility notes (set in /ops, shown in the shop, on the home and to search engines) | next: venue pages or Wallet (benchmark)
- 2026-10-14 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #79 | done | Run 68: robots.txt and sitemap.xml (home, accessibility, listed shops), in the same PR as Run 67 | next: Run 69
- 2026-10-14 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #79 | done | Run 67: "Suivre cet organisateur" (newsletter double opt-in from the home), agenda view day by day, accessibility page | next: Run 69
- 2026-10-13 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #78 | done | Run 66: home extras from the benchmark — price filter and sort, organizer chips, event JSON-LD with offers per date, add to calendar and directions in the quick view, recently viewed, installable (PWA manifest) | next: Run 67
- 2026-10-13 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #77 | done | Run 65: OPC — exchange and refund policy shown before payment, e-mail to buyers when a session's time or place changes; competitor benchmark (docs/ALKAO_COMPETITIVE_FEATURES.md) | next: structured event data (benchmark gap 4)
- 2026-10-13 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #76 | done | Run 64: alkao.ca premium home (hero carousel and search, categories, event rails, quick view, assistant, FR/EN, organizer band) | organizers opt in from /ops → Apparence
- 2026-10-13 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #74 | done | Run 63: live watch of alkao.ca every 3 hours (GitHub workflow, GET only), secret guard as its own CI step | add billets.promohavana.ca to live.yml once it serves the current ALKAO
- 2026-10-13 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #73 | done | Run 62: ALKAO deployable on Coolify (container entry: migrations on start, background jobs; production roles bootstrap instead of the test shim; /health build) | owner: Coolify settings (docs/ALKAO_DEPLOY_COOLIFY.md), see handoff
- 2026-10-13 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #72 | done | Secret guard in CI (check:secrets) after real keys were committed to .env.example (c75f797, public history) | owner rotates the leaked keys
- 2026-10-10 | ChatGPT (GitHub) | work/alkao-platform-home → PR #70 | done (merged 375e653) | Run 61: independent ALKAO homepage, default-off Brand opt-in, FR/EN SEO, TAKATAK registration CTA, white-label home redirect, deployment-safe migration order | require green qa, then merge; production cutover remains separately gated

- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #68 | PR open | Run 60: shop options in their own card, once a ticket is chosen | merge when CI is green
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #67 | done | Run 59: tickets grouped by type, Flex shown as a right; docs/DOMAINS.md (festi-ice.ca at IONOS) | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #66 | done | Run 58: options to hand over in the offline scanner manifest | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #65 | done | Run 57: per-session options to prepare at the gate; Flex Météo not listed as an item to hand over | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #64 | done | Run 56: add-on stock per session follows a session change (refused if sold out there) | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #63 | done | Run 55: options kept across session changes, shown at the gate scan | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #62 | done | Run 54: options bought listed on the tickets page and in the e-mails | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #61 | done | check:golive names a Brand without its look, an SVG logo, events on sale without a photo | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #60 | done | Run 53: shared shop links show the event (Open Graph) | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #59 | done | Run 52: QR codes inside the tickets and reminder e-mails | none
- 2026-10-09 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #58 | done | /ops Apparence: logo hint says PNG, warns on SVG (e-mail apps); test servers stop at once | none
- 2026-10-08 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #56 | done | /ops in the GROUPE TAKATAK brand (BRAND.md): navy, brand blue, electric-blue tile; colours only | none
- 2026-10-08 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #55 | done | Run 51: tickets open without a network at the gate (service worker + copy kept on the phone) | none
- 2026-10-08 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR #54 | done | Run 50: each Brand's look (logo, colour, contact, event photo) on the tickets page with a full-screen gate view, the shop and every buyer e-mail; /ops → Apparence | Havana sets its logo and colours in /ops → Apparence
- 2026-10-08 | claude (owner setup) | default branch | done | Added the work log rule, this log and the stop reminder | every agent follows AGENTS.md › Work log rule
