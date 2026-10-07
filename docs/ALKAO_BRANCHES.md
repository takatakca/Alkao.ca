# ALKAO : un seul moteur pour tous les projets

ALKAO est le moteur de billetterie du groupe TAKATAK : événements, séances, billets, ajouts,
paiements Stripe, codes QR, entrée, clients, courriels et SMS. Il sert déjà plusieurs
entreprises (Havana Resort, FESTI-ICE) et en servira d'autres. Il ne contient **aucun code
propre à une entreprise**.

## Une entreprise de plus = des données, pas du code

| Besoin d'un nouveau projet | Où ça se règle |
|---|---|
| L'entreprise elle-même | Un **Client** TAKATAK, avec ses droits (entitlement) |
| Une marque ou un site de vente | Une **Brand** du Client |
| Ses événements, séances, billets, ajouts, prix, stocks, codes promo | `/ops` de la Brand |
| Son site autorisé à revenir de Stripe | `/ops` → Paiements → « Sites autorisés après le paiement » |
| Ses paiements | Son compte Stripe Connect, branché depuis `/ops` |
| Ses clients, campagnes, courriels | Le fichier clients et les campagnes de la Brand (`/ops`) |

Le site de vente d'une entreprise (sa vitrine) est un autre dépôt : il part de la branche
`core` de `takatakca/promohavanaca` et ne parle à ALKAO que par son API publique.

## Branches et versions

| Quoi | Règle |
|---|---|
| `main` | Le moteur stable. Protégé : une PR et le contrôle `qa` vert sont obligatoires. Chaque commit construit la version MochaHost. |
| Travail | Une branche par sujet, une PR vers `main`, tests verts avant toute fusion. |
| Versions | Étiquettes `vMAJEUR.MINEUR.CORRECTIF` sur `main` (`v1.0.0` : le moteur tel qu'il sert Havana à l'automne 2026). Une instance séparée d'ALKAO se déploie depuis une étiquette, jamais depuis une branche de travail. |
| Contrats | L'API (`docs/ALKAO_API_V1.md`) et le contrat de contrôle (`docs/ALKAO_CONTROL_CONTRACT_V1.md`) ne cassent jamais dans une même version majeure. Un ajout est un nouveau champ optionnel. |

## Ce qu'il ne faut jamais faire

- Écrire le nom, le prix ou une règle d'une entreprise dans le code (`if client === …`).
  Tout ce qui varie d'une entreprise à l'autre est une donnée de son Client ou de sa Brand.
- Mettre des données de clients réels dans les tests ou dans GitHub : les tests utilisent des
  données inventées, sur une base PostgreSQL locale et jetable.
- Toucher au projet Supabase de TAKATAK (`pcjfahhlozsseqqevimi`) ou à celui de FESTI-ICE :
  ALKAO a sa propre base.
