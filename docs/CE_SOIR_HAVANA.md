# Halloween Havana en vente sur alkao.ca : votre liste (choix B, mise à jour le 24 octobre 2026)

## Urgent (24 octobre) : alkao.ca est en panne depuis le 22

**Ce qu'on voit.** alkao.ca répond « no available server » (erreur 503) depuis le 22 octobre, entre 9 h 36 et 12 h. Le serveur Coolify tourne, mais le conteneur ALKAO ne démarre plus. Le contrôle « Live » de GitHub échoue depuis ce moment.

**Ce que ça ne touche pas.** promohavana.ca vend encore avec **Weezevent**, ce soir comme d'habitude : le retrait de Weezevent n'a jamais été déployé. Personne ne perd de vente ce soir.

**La cause probable.** Avant la version du Run 102, ALKAO refusait de démarrer si un réglage était **vidé au lieu d'être supprimé** dans Coolify. Par exemple : `ALKAO_HOME_URL` laissé vide à l'étape 4, ou une clé Stripe ou Resend collée vide ou mal formée.
- Le code fusionné le 22 n'est pas en cause : la même base, avec les nouvelles migrations, démarre sans erreur (vérifié le 24).
- La version du Run 102 démarre même avec un réglage vide, et elle nomme le réglage à corriger sans jamais afficher sa valeur.

**Pour remettre alkao.ca en ligne (5 minutes, dans Coolify) :**
1. Coolify, ressource ALKAO, onglet **Logs** (ou le dernier **Deployment**). Cherchez `ZodError`, ou la ligne `ALKAO cannot start: fix …` : elle nomme le réglage fautif.
2. Onglet **Environment Variables** :
   - un réglage **vide** : supprimez-le (icône poubelle), ne le laissez pas vide ;
   - un réglage **mal collé** : recollez la valeur, sans espace ni guillemets ;
   - `STRIPE_SECRET_KEY` commence par `sk_live_` ou `sk_test_`, et `STRIPE_WEBHOOK_SECRET` par `whsec_`.
3. **Redeploy.** Attendez 2 minutes, puis ouvrez `https://alkao.ca/health`. On doit y lire `"service":"alkao"`.
4. Si la page reste en 503, envoyez-moi les 20 dernières lignes des Logs (**sans aucune clé**), et je trouve la suite.

**Ce soir et le 31.** Halloween du 24 se vend sur Weezevent : on ne change rien aujourd'hui. Pour le 31, on passe à ALKAO seulement si les étapes 1 à 6 ci-dessous sont faites d'ici mardi 28. Sinon, Weezevent vend aussi le 31, et ALKAO sert aux prochains événements (préventes, coupons, passes festival).

## Où on en est (vérifié le 22 octobre 2026)

**Déjà fait (le 21 octobre, par Codex et par moi) :**
- alkao.ca roule la dernière version, avec sa base à jour (`/health` et `/health/ready` vérifiés le 22).
- Havana Resort est créé dans ALKAO, et la connexion du personnel à /ops fonctionne.
- Halloween est importé avec la page complète : les samedis 24 et 31, 3 000 places chacun, **encore en brouillon**.
- L'apparence, la politique de remboursement et le site de retour sont enregistrés.
- promohavana.ca est à jour et connaît déjà ALKAO (ses trois réglages sont en place).

**Pourquoi rien ne se vend encore sur ALKAO :**
1. La clé Stripe du serveur est une **clé de TEST** : aucun vrai paiement n'est possible.
2. Havana n'a **pas encore branché son compte Stripe** dans ALKAO.
3. La clé **Resend est refusée** (« API key is invalid ») : les billets ne partiraient pas par courriel.
4. Les deux soirées sont en **brouillon**. On les publie seulement après un achat test réussi.

**Deux problèmes vus sur le site :**
- **alkao.ca renvoie vers promohavana.ca/billets.** Ce n'est pas un bogue du code. C'est le réglage `ALKAO_HOME_URL`, ajouté sur le serveur ALKAO dans Coolify. Il faut le supprimer, puis redémarrer ALKAO. `check:golive` le signale maintenant.
- **promohavana.ca/billets ne vend rien** (« Achats en ligne bientôt disponibles »). Les autres boutons menaient encore à Weezevent. Weezevent est retiré du site à votre demande. Jusqu'à la publication sur ALKAO, chaque bouton « Acheter » mène à cette page d'aperçu, **sans vente en ligne**.

## Ce qui reste, dans l'ordre

| # | Qui | Quoi | Où |
|---|---|---|---|
| 1 | **Vous** | Copier la clé `sk_live_…` du compte Stripe **TAKATAK** (mode live), avec Connect activé, dans `STRIPE_SECRET_KEY`. Ou donner à l'opérateur l'accès à ce compte : celui qu'il voit est un autre compte, « ALKAO.CA ». | Stripe, puis Coolify, ressource ALKAO |
| 2 | **Vous** | Créer le webhook live de l'étape 2 et copier son `whsec_…` dans `STRIPE_WEBHOOK_SECRET`. | Stripe, puis Coolify |
| 3 | **Vous** | Créer une nouvelle clé Resend pour un domaine vérifié, la mettre dans `RESEND_API_KEY`, et vérifier `ALKAO_EMAIL_FROM`. | resend.com, puis Coolify |
| 4 | Opérateur | **Supprimer `ALKAO_HOME_URL`** avec l'icône poubelle, sans la laisser vide, puis Redeploy d'ALKAO. | Coolify, ressource ALKAO |
| 5 | **Vous** | Brancher le Stripe de Havana : Paiements, puis Connecter Stripe, avec les coordonnées de l'entreprise et du compte bancaire. | alkao.ca/ops |
| 6 | **Vous** | Acheter un vrai billet enfant, vérifier le courriel, le code QR et un scan, puis le rembourser. | alkao.ca, puis /ops |
| 7 | Vous ou l'opérateur | Mettre la capacité exacte (3 000 moins les billets Weezevent de chaque samedi), puis publier l'événement et ses deux séances. | /ops, Événements |
| 8 | Opérateur | Redeploy de Promo Havana avec le retrait de Weezevent. Le site passe à ALKAO de lui-même dès que les dates sont publiées. | Coolify, ressource Promo Havana |
| 9 | **Vous** | Fermer la vente sur Weezevent. Les billets déjà vendus restent valides et se scannent avec l'application Weezevent. | weezevent.com |

**Les étapes 1, 2, 3 et 5 demandent vos comptes, et personne d'autre ne peut les faire.** Dès qu'elles sont faites, l'opérateur (Codex ou une personne) fait les étapes 4, 7 et 8 en quelques minutes.

Le détail de chaque étape suit. Les étapes déjà faites sont marquées ✔.

## Préparé dans le code (Run 94, 18 octobre)

- La page Halloween est entièrement remplie dans `catalogs/havana-halloween-2026.json`, à partir des pages publiques de promohavana.ca et havanaresort.ca :
  - le résumé et l'avis « à savoir » ;
  - les 5 points forts et les 6 photos ;
  - les 4 étapes « Le jour J » et les 6 questions de la FAQ ;
  - ce que comprend chaque billet.
- L'import met la page en place en une commande (étape 5). L'option `--update-page` la rafraîchit plus tard sans toucher aux prix ni aux dates.
- La nouvelle page d'événement, le tableau de bord, l'assistant (éteint) et la page des billets sont dans `main`.

## Votre choix : B, tout sur ALKAO (confirmé le 20 octobre)

promohavana.ca vendait les samedis 24 et 31 octobre avec Weezevent. Avec le choix B, ALKAO vend tout et la vente Weezevent ferme. Les deux inventaires ne se parlent pas : **l'ordre du passage compte**.

1. Étapes 1 à 7, dans l'ordre. ALKAO est prêt, puis l'import met les soirées en vente sur alkao.ca avec une **capacité prudente**, plus basse que la vraie (étape 5). Enfin, un achat test réussit. Pendant ce temps, Weezevent vend encore.
2. Étape 8 : promohavana.ca passe à ALKAO.
   - Le site le fait de lui-même dès qu'ALKAO a des dates en vente.
   - Weezevent est retiré du site depuis le 22 octobre, à votre demande : avant la publication, les boutons mènent à l'aperçu, sans vente en ligne.
   - **Le même jour**, vous fermez la vente Weezevent.
3. Juste après la fermeture : comptez les billets Weezevent vendus **pour chaque samedi**. Montez ensuite la capacité de chaque soirée dans /ops au chiffre exact (étape 5, point 3).

**Les billets Weezevent déjà vendus restent valides.** Ne les annulez pas et ne les remboursez pas. À l'entrée, ils se scannent avec l'application de contrôle de Weezevent, pas avec ALKAO (voir « Les samedis à l'entrée » plus bas).

La capacité (3 000 places par soirée) et la politique de remboursement ont été confirmées par vous et enregistrées le 21 octobre.

## Étape 1 — Coolify : mettre ALKAO à jour (✔ fait le 21 octobre ; restent les clés Stripe live et Resend, et le retrait de `ALKAO_HOME_URL`)

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

## Étape 3 — Créer Havana dans ALKAO (✔ fait le 21 octobre)

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

## Étape 5 — Charger Halloween (✔ importé en brouillon le 21 octobre, 3 000 places par soirée ; reste la publication)

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

## Étape 6 — Apparence et politique (✔ enregistrées le 21 octobre)

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
