# Halloween Havana en vente sur alkao.ca : votre liste (Run 94, choix B confirmé le 20 octobre 2026)

Le code est prêt et fusionné. Ce qui reste demande l'accès au serveur et aux comptes : Coolify, Stripe, les clés, la base de données. Je ne l'ai pas, et les secrets ne doivent jamais passer par le clavardage. Ces étapes vous reviennent, ou à la personne qui gère Coolify.

**Temps total : environ 1 heure, dans l'ordre ci-dessous.** Cochez au fur et à mesure.

**Pour vendre le samedi 24 octobre, terminez les étapes 1 à 8 au plus tard le vendredi 23 au soir.** Chaque jour sans billetterie en ligne coûte des ventes.

## Ce qui est déjà fait (rien à faire de votre côté)

- La page Halloween est entièrement remplie dans `catalogs/havana-halloween-2026.json`, à partir des pages publiques de promohavana.ca et havanaresort.ca :
  - le résumé et l'avis « à savoir » ;
  - les 5 points forts et les 6 photos ;
  - les 4 étapes « Le jour J » et les 6 questions de la FAQ ;
  - ce que comprend chaque billet.
- L'import met la page en place en une commande (étape 5). L'option `--update-page` la rafraîchit plus tard sans toucher aux prix ni aux dates.
- La nouvelle page d'événement, le tableau de bord, l'assistant (éteint) et la page des billets sont dans `main`.
- État vérifié le 18 octobre avec `check:golive` :
  - alkao.ca répond, mais sur une **ancienne version** ;
  - **Stripe n'y est pas configuré** ;
  - **Havana n'est pas créé** ;
  - promohavana.ca vend toujours avec **Weezevent**, sur son ancienne version.

## Votre choix : B, tout sur ALKAO (confirmé le 20 octobre)

promohavana.ca vendait les samedis 24 et 31 octobre avec Weezevent. Avec le choix B, ALKAO vend tout et la vente Weezevent ferme. Les deux inventaires ne se parlent pas : **l'ordre du passage compte**.

1. Étapes 1 à 7, dans l'ordre. ALKAO est prêt, puis l'import met les soirées en vente sur alkao.ca avec une **capacité prudente**, plus basse que la vraie (étape 5). Enfin, un achat test réussit. Pendant ce temps, Weezevent vend encore.
2. Étape 8 : promohavana.ca passe à ALKAO.
   - Le site le fait de lui-même dès qu'ALKAO a des dates en vente. Avant, il reste sur Weezevent : il n'y a donc jamais de trou dans la vente.
   - **Le même jour**, vous fermez la vente Weezevent.
3. Juste après la fermeture : comptez les billets Weezevent vendus **pour chaque samedi**. Montez ensuite la capacité de chaque soirée dans /ops au chiffre exact (étape 5, point 3).

**Les billets Weezevent déjà vendus restent valides.** Ne les annulez pas et ne les remboursez pas. À l'entrée, ils se scannent avec l'application de contrôle de Weezevent, pas avec ALKAO (voir « Les samedis à l'entrée » plus bas).

**Ce qu'il me faut encore de vous :**
- la capacité réelle du site par soirée (le nombre total de personnes) ;
- votre accord sur la politique de remboursement proposée à l'étape 6, ou votre propre texte.

## Étape 1 — Coolify : mettre ALKAO à jour (personne qui gère Coolify, 15 min)

1. Ouvrir Coolify, puis la ressource **ALKAO**, puis **Environment Variables**.
2. Vérifier que ces variables existent. Si non, les ajouter. **Tapez les secrets vous-même** dans Coolify, jamais ailleurs. Pour générer une valeur au hasard : `openssl rand -base64 48`.

   | Variable | Valeur |
   |---|---|
   | `ALKAO_MIGRATE_ON_START` | `true` |
   | `ALKAO_OPERATIONAL_API_ENABLED` | `true` |
   | `ALKAO_PUBLIC_URL` | `https://alkao.ca` (déjà correct d'après le test) |
   | `ALKAO_CONTROL_KEYS` | `havana-1:` suivi d'une valeur générée (48 caractères). Gardez-la pour l'étape 3 |
   | `ALKAO_CREDENTIAL_MASTER_SECRET` | une valeur générée. **Ne jamais la changer après le lancement** : tous les codes QR cesseraient de fonctionner |
   | `STRIPE_SECRET_KEY` | la clé `sk_live_…` du compte Stripe de la plateforme TAKATAK, avec Connect activé |
   | `STRIPE_WEBHOOK_SECRET` | le `whsec_…` obtenu à l'étape 2 |
   | `ALKAO_STRIPE_ONBOARDING_REFRESH_URL` et `ALKAO_STRIPE_ONBOARDING_RETURN_URL` | `https://alkao.ca/ops` |
   | `RESEND_API_KEY` | la clé Resend (envoi des billets par courriel) |
   | `ALKAO_EMAIL_FROM` | une adresse d'un domaine **vérifié dans Resend**, par exemple `billets@takatak.ca` |
   | `SUPABASE_JWKS_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | le même projet Supabase que TAKATAK, pour la connexion à /ops (déjà en place d'après le test) |

3. Dans **Configuration**, cocher **Include Source Commit in Build**.
4. Cliquer **Redeploy**, sur la branche `main`.
5. Vérifier dans un navigateur :
   - https://alkao.ca/health doit montrer `"build"` suivi du numéro du commit ;
   - https://alkao.ca/health/ready doit montrer `"schema":"current"`.

## Étape 2 — Stripe : le webhook de la plateforme (titulaire du compte Stripe TAKATAK, 10 min)

1. Dans Stripe, ouvrir **Développeurs**, puis **Webhooks**, puis **Ajouter une destination**.
2. Choisir **Événements des comptes connectés (Connect)**.
3. Adresse : `https://alkao.ca/v1/webhooks/stripe`.
4. Événements :
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `account.updated`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.updated`
   - `charge.dispute.closed`
   - `charge.dispute.funds_withdrawn`
   - `charge.dispute.funds_reinstated`
5. Copier le **secret de signature** (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET` sur Coolify (étape 1), puis **Redeploy**.

## Étape 3 — Créer Havana dans ALKAO (personne qui gère le serveur, 10 min)

1. Préparer `plan.json` en copiant `provisioning.example.json`. Y mettre :
   - le vrai **Client** et la vraie **Brand** Havana Resort de TAKATAK. Leurs identifiants (UUID) sont dans le tableau de bord TAKATAK ;
   - votre identifiant d'utilisateur Supabase (votre compte TAKATAK), avec le rôle `owner` ;
   - `"ticketing": { "status": "active" }` ;
   - la commission convenue.
2. Prévisualiser : `npm run control:apply -- plan.json --dry-run`.
3. Envoyer : `ALKAO_URL=https://alkao.ca ALKAO_CONTROL_KEY_ID=havana-1 ALKAO_CONTROL_SECRET=… npm run control:apply -- plan.json`. Le secret est celui de l'étape 1. **Ne mettez `plan.json` ni le secret dans Git.**

## Étape 4 — Brancher le Stripe de Havana (vous, 5 min)

1. Aller sur https://alkao.ca/ops et vous connecter avec votre compte TAKATAK.
2. Choisir Havana Resort, puis **Paiements**, puis **Connecter Stripe**, et terminer l'inscription de Havana chez Stripe.
3. Toujours dans **Paiements**, ajouter `https://www.promohavana.ca` aux sites autorisés après paiement.

## Étape 5 — Charger Halloween (personne qui gère le serveur, 2 min)

Dans Coolify, ouvrir **Terminal** dans le conteneur ALKAO. `DATABASE_URL` y est déjà.

**Choisir `<N>`, la capacité prudente :** prendre la capacité réelle du site, enlever les billets Weezevent vendus pour le samedi qui en a le plus, puis enlever une marge pour les ventes Weezevent d'ici la fermeture (par exemple 50). Exemple : 1 000 places − 380 vendus − 50 de marge = 570.

```bash
# Essai : tout est fait, puis annulé.
npm run events:import -- --client <clientId> --brand <brandId> catalogs/havana-halloween-2026.json --capacity <N> --dry-run
# Pour vrai : les samedis 24 et 31 sont mis en vente, avec la page complète, et l'événement est affiché sur alkao.ca.
npm run events:import -- --client <clientId> --brand <brandId> catalogs/havana-halloween-2026.json --capacity <N> --publish --list-on-alkao
```

Les soirées déjà passées (3, 10 et 17 octobre) ne sont jamais créées.

3. **Après la fermeture de Weezevent (étape 8)**, mettre la capacité exacte de chaque soirée :
   - le calcul : capacité réelle moins les billets Weezevent vendus pour ce samedi ;
   - où : dans /ops, ouvrir **Événements**, puis **Halloween Havana 2026**, puis la section **Séances** ;
   - comment : cliquer sur le chiffre de la colonne **Capacité** et taper le nouveau nombre.

   ALKAO refuse un chiffre plus bas que les places déjà vendues ou réservées.

## Étape 6 — Apparence et politique (vous, 10 min)

Dans /ops, ouvrir **Apparence** et remplir :

- [ ] Logo : `https://www.promohavana.ca/brand/havana-resort-logo-blanc.png`
- [ ] Couleur de Havana
- [ ] Courriel : `info@havanaresort.ca` ; téléphone : `514 774-7979` ; adresse : `631, 7e Rang, Maricourt (Québec) J0E 2L2`
- [ ] **Politique d'échange et de remboursement.** Elle est montrée avant le paiement, comme la loi l'exige, et elle répond à la question « Puis-je me faire rembourser ? » dans la FAQ.
  - Havana n'en publie aucune pour l'Halloween : ni promohavana.ca, ni havanaresort.ca, ni la page Weezevent. Seule la passe d'un jour d'été dit « non remboursable ».
  - **Proposition, à approuver ou à corriger avant de la coller :**

    > Les billets ne sont ni remboursables ni échangeables, sauf si Havana annule la soirée. Dans ce cas, vous choisissez entre un remboursement complet et un billet pour un autre samedi d'octobre. Questions : info@havanaresort.ca ou 514 774-7979.

  - Si une soirée est annulée, le remboursement est de toute façon dû selon la loi. ALKAO le fait depuis /ops → **Commandes**.
- [ ] Vérifier que **Afficher mes événements sur ALKAO** est coché (l'import l'a fait).

## Étape 7 — Vérifier et faire un achat test (vous, 10 min)

1. Lancer `npm run check:golive -- --url https://alkao.ca --client <clientId> --brand <brandId>`. Il ne doit rester aucun ✘.
2. Ouvrir https://alkao.ca/ : « Halloween Havana 2026 » doit apparaître, à partir de 12 $ + taxes.
3. Acheter **un vrai billet enfant** avec votre carte. Vérifier :
   - le courriel avec les billets ;
   - les codes QR sur la page des billets ;
   - un scan dans /ops → **Scanner**.
4. Rembourser ce billet depuis /ops → **Commandes**.

## Étape 8 — promohavana.ca vend par ALKAO, puis Weezevent ferme (personne qui gère Coolify, 10 min)

1. Dans Coolify, ouvrir la ressource **Promo Havana** et mettre :
   - `ALKAO_URL=https://alkao.ca`
   - `ALKAO_CLIENT_ID=<clientId>`
   - `ALKAO_BRAND_ID=<brandId>`
2. **Redeploy**. Cela met aussi en ligne les pages refaites de promohavana.ca.
3. Vérifier :
   - https://www.promohavana.ca/api/site/v1/health montre un nouveau `"build"` ;
   - les boutons d'achat de promohavana.ca mènent à ALKAO, plus à Weezevent ;
   - la page `/billets` vend les mêmes soirées qu'alkao.ca.
4. **Tout de suite après**, dans Weezevent, fermer la vente « Passe journalière - HALLOWEEN AU HAVANA ».
5. Compter dans Weezevent les billets vendus pour le samedi 24 et pour le samedi 31, puis faire l'étape 5, point 3.

## Les samedis 24 et 31 à l'entrée (vous et votre équipe)

- **Billets ALKAO :** dans /ops, ouvrir **Scanner**. Le scanner fonctionne aussi sans réseau, et les scans s'envoient au retour du réseau.
- **Billets Weezevent achetés avant la fermeture :** les scanner avec l'application de contrôle de Weezevent, sur un autre téléphone. ALKAO ne les reconnaît pas.
- Le plus simple : une file ALKAO et une file Weezevent, ou deux téléphones au même poste.
- La présence totale est la somme des deux. Le tableau de bord d'ALKAO compte seulement les billets ALKAO.

## Étape 9 — Facultatif : l'assistant de rédaction

Voir `docs/ASSISTANT_REDACTION.md`. Il faut mettre `ALKAO_ASSISTANT_ENABLED=true` et `ANTHROPIC_API_KEY` dans Coolify. C'est payant à l'usage, environ 0,04 $ CA par brouillon, avec un plafond par jour.

## Si quelque chose bloque

- **Le build ne change pas après Redeploy :** regardez le journal de déploiement dans Coolify (issue #84).
- **« La billetterie n'est pas active » :** l'étape 3 n'a pas été envoyée, ou `ALKAO_OPERATIONAL_API_ENABLED` n'est pas à `true`.
- **Le paiement ne finit pas :** vérifiez l'étape 2 (le webhook et son secret) et l'étape 4 (le Stripe de Havana).
- **promohavana.ca renvoie encore vers Weezevent :**
  - ALKAO n'a aucune date en vente pour Havana (étape 5 faite sans `--publish`), ou ne répond pas ;
  - ou les trois variables de l'étape 8 manquent.

  promohavana.ca ne passe à ALKAO que si ALKAO répond et a des dates en vente : c'est voulu, pour ne jamais couper la vente.
