# ALKAO Offres — feuille de route (style Groupon, Tuango, PromoRabais)

**Ordre du propriétaire, 13 novembre 2026 :** faire d'ALKAO une plateforme de préventes et de rabais comme Groupon, Tuango et PromoRabais. Elle sert au marketing et aux médias sociaux de GROUPE TAKATAK. Elle doit être la plus premium et la plus sécuritaire possible, et ajouter ce qui est un **must**, un **besoin** et un **souhait**. Les autres dépôts takatakca sont recyclés quand ils ont déjà la pièce, et TAKATAK-V1 reste le plan de contrôle. Chaque étape laisse une note signée dans GitHub et Google Drive, avant, pendant et après.

**Règle qui ne change pas :** aucun faux rabais, aucun faux prix barré, aucune fausse urgence. Chaque prix, chaque valeur, chaque date de fin et chaque quantité vient des réglages réels du commerçant, et le serveur recalcule tout au paiement.

## Déjà construit (à recycler, pas à refaire)

| Pièce | Où | Run |
|---|---|---|
| Prix de prévente (date ou quantité de fin, gardée par la base) | `docs/PREVENTES_COUPONS.md` | 97 |
| Paliers lève-tôt → prévente → régulier | idem | 104 |
| Coupons publics en un clic ou par lien, codes privés, non cumulables | idem | 97, 99 |
| Codes uniques pour entreprises partenaires (CSV, lien par personne) | idem | 103 |
| Offre de retour (rabais pour le prochain événement) | idem | 105 |
| Passes festival (un billet, toutes les dates) | `docs/PASSES_FESTIVAL.md` | 98 |
| « Préventes et rabais » en vedette, filtre `?offres=1` | `docs/ALKAO_CA_VITRINE.md` | 107 |
| Paiement Stripe Connect : l'argent va au commerçant, la commission TAKATAK en frais d'application | README | 02 |
| Code QR signé Ed25519 (`ALK1`), scanner hors ligne, une seule entrée | `docs/ALKAO_SCANNER_V1.md` | 03, 84–89 |
| Remboursements, litiges, rétrofacturations, révocation du QR | `docs/ALKAO_API_V1.md` | 05, 19 |
| Rapports TPS/TVQ, exports CSV | `src/ops/reports.ts` | 04 |
| Provenance des ventes par `utm_source` / `utm_medium` / `utm_campaign` (Facebook, Instagram, TikTok…) | `src/ops/reports.ts` | 49 |
| Aperçu de partage par événement (Open Graph, carte Twitter) | `src/api/shop-ui.ts` | 08 |
| Fichier clients, campagnes courriel et texto (LCAP, Loi 25), infolettre, liste d'attente | README | 42–48 |
| Accessibilité WCAG 2.1 AA vérifiée par axe à chaque changement | `test/a11y/axe.test.ts` | 17, 108 |
| Plan de contrôle TAKATAK-V1 (clients, marques, abonnement Billetterie) | `docs/ALKAO_CONTROL_CONTRACT_V1.md` | 01 |

## MUST : ce qui fait une plateforme de type Groupon

1. **Bons d'achat de commerces** (Run 109) : un restaurant, un spa ou une activité vend un bon avec une **valeur** (« valeur 80 $ ») et un **prix** (« 45 $ »), une **période de validité** (du… au…) et des **conditions** (les petites lignes). Le bon s'échange **une fois**, par code QR au commerce, avec le scanner qui existe déjà : une séance couvre toute la période de validité, et la fenêtre d'entrée du scanner suit la séance. Il reste à ajouter la valeur, les conditions, le format « bon » et l'affichage « Valide jusqu'au … » partout (accueil, boutique, billets, courriel).
2. **Limite par client** (Run 110) : par exemple 2 bons par personne pour toute l'offre, et pas seulement par commande. Elle est gardée par la base, comme la quantité des préventes.
3. **Page Offres dédiée** (Run 111) : `/offres`, toutes les offres en cours, triées par rabais, par fin la plus proche, par ville ou par catégorie, avec leur propre aperçu de partage pour les médias sociaux.
4. **Partage social qui vend** (Run 111) : sur chaque offre, des boutons de partage avec les liens UTM déjà comptés (Run 49) et un aperçu qui montre le vrai rabais.

## BESOIN : ce qui la rend sûre et rentable

5. **Rappel avant l'expiration d'un bon** : un courriel 7 jours avant la fin de la validité, sur le modèle des rappels d'événement (Run 45).
6. **Passif des bons non échangés** : bons vendus, échangés et expirés, au tableau de bord et dans un export prêt pour 4CCOUNTING.
7. **Validation au comptoir sans appareil** : le commerçant entre le code du bon, sur le modèle de l'entrée manuelle (Run 22).
8. **Vérification des commerçants** avant leur première offre, avec TAKATAK LIVE ID (`takatakca/LIVEID-TAKATAK`) contre la fraude.
9. **Vitrine sur takatak.ca** : les offres ALKAO en cours apparaissent sur takatak.ca (`takatak-v1`, page `/deals`), par l'API publique d'ALKAO.
10. **Avis vérifiés** après l'échange du bon.

## SOUHAIT : ce qui la rend premium

11. **Offrir un bon** à quelqu'un, avec le transfert existant (Run 80, désactivé par défaut).
12. **Offre du jour / vente éclair**, avec un compte à rebours vrai (la boutique en a déjà un, Run 101).
13. **Parrainage** : « Partagez, et vous et votre ami recevez X $ ».
14. **Points LOY4LTY** sur les achats ALKAO et **cartes-cadeaux REW4RD** comme mode de paiement (`takatakca/LOY4LTY`, `takatakca/REW4RD`).
15. **Bons dans Apple Wallet et Google Wallet.**
16. **Offres de produits livrés**, suivies par TR4CKER (`takatakca/TR4CKER`).

## Dépôts takatakca à recycler

| Dépôt | Ce qu'il apporte à ALKAO Offres |
|---|---|
| `takatak-v1` | Plan de contrôle (clients, marques, abonnement), page `/deals` et codes TAKATAK, tableau de bord |
| `LIVEID-TAKATAK` | Vérification d'identité (vidéo, pièce d'identité) contre la fraude des commerçants |
| `REW4RD` | Cartes-cadeaux code + QR, passif ; échange d'un bon comme mode de paiement Clover |
| `LOY4LTY` | Points par téléphone |
| `M4RKETING` | Offres par segment de clients Clover |
| `4CCOUNTING` | Comptabilité TPS/TVQ des commerçants Clover, export pour le comptable |
| `TR4CKER` | Suivi de livraison (offres de produits) |
| `SC4NNER` | Étiquettes et codes-barres de produits |
| `CH4T` | Messages clients (spécification seulement pour l'instant) |

## Journal de cette feuille de route

- 2026-11-13 — Claude : créée ; Run 108 (axe sur « Préventes et rabais ») ; Run 109 (bons d'achat) commencé.

— Signé : Claude (Claude Code, session cloud du dépôt takatakca/Alkao.ca), 2026-11-13.
