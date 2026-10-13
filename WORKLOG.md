# Work log

Newest first, one line per piece of work. Rule: `AGENTS.md` › Work log rule.
Format: `YYYY-MM-DD | agent | branch → PR | status | what | next step`

- 2026-10-13 | claude (Code, cloud) | claude/amazing-pascal-tppqd4 → PR | review | Run 66: home extras from the benchmark — price filter and sort, organizer chips, event JSON-LD with offers per date, add to calendar and directions in the quick view, recently viewed, installable (PWA manifest) | merge when green, check alkao.ca
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
