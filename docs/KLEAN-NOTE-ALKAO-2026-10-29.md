# KLEAN — Alkao.ca — note de travail — 2026-10-29

Projet 8/10. Agent : KLEAN. Client : alkao.ca. Repo : takatakca/Alkao.ca.
Règle appliquée : lecture seule pour le code, aucune poussée sur main, aucun merge,
aucun déploiement, aucun secret. Aucun mot de passe, code ou secret dans cette note.

## Entrepris

1. Vérification en lecture seule du repo takatakca/Alkao.ca (connecteur GitHub,
   identité takatakca) : main actuel, PR #53, issue #84, état du déploiement.
2. Revue exacte de la PR #53 et suite proposée pour l'issue #84.
3. Dépôt de cette note dans Google Drive (dossier « 00 — Opérations TAKATAK »)
   et dans GitHub via branche + PR (jamais de push direct sur main, jamais de merge).

## Vérifié

- **Main actuel : `535cd93540ecb71641c04fd1d68e15e92e672a56`**, merge de la PR #102
  (« ci: deploy alkao.ca automatically after each green CI on main »),
  2026-10-28T07:09:02Z. Confirmé par lecture des commits, inchangé par rapport
  au contexte du 2026-10-29.
- **PR #53 — OUVERTE, non mergée.** Titre : « worklog: claim Havana go-live on
  billets.promohavana.ca (active) ». Branche : `claude/worklog-havana-golive`,
  tête `d87e7487362cd2f096b647c8b54cce5cc16f65a9`, base `main` à
  `60dea2e2cebd55b058dc613e8cf55a25e4c61c10` (2026-10-08). Créée le
  2026-10-08, jamais mise à jour depuis. Contenu vérifié par lecture de
  WORKLOG.md sur la branche : une seule ligne ajoutée —
  « 2026-10-08 | claude (Cowork, Chrome) | ops only, no code → PR for this line |
  active | Havana go-live on billets.promohavana.ca (MochaHost): release Run 49+,
  Stripe test Connect webhook, Resend webhook secret, control:apply, /ops setup,
  test purchase, check:golive | install the newest MochaHost release ».
  Le corps de la PR promettait de mettre la ligne à son statut final avant que
  l'agent s'arrête — cela n'a jamais été fait.
- **Issue #84 — OUVERTE.** Titre : « Production: déployer main sur Coolify,
  exposer SHA et valider la base ALKAO ». Créée le 2026-10-14, dernière mise à
  jour le 2026-10-29T17:08:26Z (contenu de cette mise à jour non vérifié, voir
  Blocages). Critère de clôture : commit ALKAO actuel confirmé sur
  `https://alkao.ca/health`, readiness et migrations contrôlées, catalogue privé
  par défaut, parcours public observé, puis autorisation distincte avant
  d'activer des paiements réels. Cases du corps toujours ouvertes selon le
  texte lu : base dédiée ALKAO à confirmer, rotation des secrets exposés dans
  l'historique public, variables Coolify (`ALKAO_MIGRATE_ON_START`,
  `ALKAO_RUN_WORKERS`, provenance du commit, healthcheck `/health/ready`),
  redéploiement et vérifications `/health`, `/health/ready`, `/salles`,
  sitemap, Stripe et commandes.
- **Déploiement — NON vérifié par KLEAN.** La PR #102 (mergée 2026-10-28) met
  en place un déploiement automatique Coolify après chaque CI verte sur main,
  avec vérification de `/health`. KLEAN n'a ni accès Coolify ni vérification
  en direct : le déploiement effectif de `535cd93` sur alkao.ca n'est PAS
  confirmé par cette note. `docs/ALKAO_DEPLOY_COOLIFY.md` (lu sur main)
  confirme qu'ALKAO est sa propre application Coolify avec sa propre base de
  données, non partagée avec Promo Havana, TAKATAK ou FESTI-ICE — cohérent
  avec la case « base dédiée » de l'issue #84, mais ce n'est pas une preuve
  que cette case est cochée.

## Revue exacte — PR #53 : recommandation = FERMER SANS MERGER

Ne pas merger en l'état, pour trois raisons vérifiées :

1. **Périmètre :** la revendication concerne le go-live de Havana sur
   billets.promohavana.ca, pas Alkao. Elle n'a pas sa place dans le worklog
   du repo Alkao.ca.
2. **Fraîcheur :** base vieille de 21 jours (`60dea2e`, 2026-10-08) contre un
   main à `535cd93` ; statut « active » jamais finalisé, contrairement à la
   promesse du corps de la PR.
3. **Valeur :** la ligne ne prouve rien sur Alkao et son « next step »
   (installer la dernière release MochaHost) date du 2026-10-08.

Si la revendication Havana a encore de la valeur, la déplacer dans le worklog
du repo promohavanaca, avec son statut final réel. Si le propriétaire insiste
pour la garder ici : rebaser sur main actuel, marquer le statut final vérifié
(go-live réellement arrivé ou non), puis seulement envisager le merge —
décision propriétaire, pas KLEAN.

## Suite proposée — issue #84 (étapes propriétaire seulement)

1. Confirmer que la base utilisée est bien dédiée à ALKAO (jamais le master
   TAKATAK / FESTI-ICE) et préserver l'historique de commandes et de billets.
2. Faire la rotation des secrets exposés dans l'historique public (incident
   décrit dans `docs/TAKATAK_AGENT_HANDOFF.md`), sans jamais copier de valeur
   dans GitHub.
3. Configurer l'application Coolify `alkao.ca` selon le corps de l'issue, puis
   vérifier `/health` (build = commit actuel), `/health/ready` HTTP 200 et
   `schema=current` (ou scénario `unknown` documenté).
4. Vérifier `/salles`, ses URLs de lieu, la version anglaise et le sitemap ;
   ne rien exposer pour un organisateur non autorisé.
5. Suivre `docs/ALKAO_GO_LIVE.md` et `docs/ALKAO_DEPLOY_COOLIFY.md`, valider
   Stripe et les commandes, et obtenir une autorisation distincte avant tout
   paiement réel.

KLEAN ne redéploie rien et ne touche à aucun secret : ces étapes restent au
propriétaire (ou à l'agent désigné avec accès Coolify).

## Poussé

- **Aucun code poussé, aucun merge, aucun déploiement.**
- Cette note : déposée dans Google Drive (voir ID ci-dessous) et dans GitHub
  via branche + PR (voir numéro ci-dessous), jamais sur main directement.
- Autres repos : aucun touché.

## Blocages / limites de vérification

- Le serveur GitHub MCP actuel n'annonce plus `get_pull_request`, `get_issue`,
  `get_pull_request_files` ni `get_pull_request_status` : le diff de la PR #53
  a été vérifié par lecture de WORKLOG.md sur sa branche, mais le statut des
  checks CI de la PR #53 n'a pas pu être vérifié.
- Le contenu de la mise à jour de l'issue #84 du 2026-10-29T17:08:26Z
  (commentaires éventuels) n'a pas pu être lu avec les outils en lecture seule
  disponibles.
- Une limite de débit GitHub (429) a été rencontrée une fois pendant les
  lectures ; reprise réussie après attente, sans perte.
- Aucun accès Coolify, aucune vérification en direct de `alkao.ca/health` :
  l'état réel du déploiement reste à confirmer par le propriétaire.
