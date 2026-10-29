# KLEAN — Alkao.ca — Proposition de fermeture PR #53 — 2026-10-29

Repo : takatakca/Alkao.ca. Client : alkao.ca.
Règle appliquée : docs seulement, aucun merge, aucun déploiement, aucun secret,
aucun push direct sur main, aucun envoi au nom de l'utilisateur.
Aucun mot de passe, code ou secret dans ce document.
Signé KLEAN.

## Ce que KLEAN a vérifié le 2026-10-29 (audit indépendant)

- Main actuel : `535cd93540ecb71641c04fd1d68e15e92e672a56`, merge de la
  PR #102 (« ci: deploy alkao.ca automatically after each green CI on main »),
  2026-10-28T07:09:02Z. Inchangé par rapport à la note de la vague 10.
- PR #53 — OUVERTE, non mergée. Titre : « worklog: claim Havana go-live on
  billets.promohavana.ca (active) ». Branche : `claude/worklog-havana-golive`,
  tête `d87e7487362cd2f096b647c8b54cce5cc16f65a9`, base main
  `60dea2e2cebd55b058dc613e8cf55a25e4c61c10` (2026-10-08). Créée le
  2026-10-08, jamais mise à jour depuis. Diff vérifié : un seul fichier,
  `WORKLOG.md`, une seule ligne ajoutée (1 addition, 0 suppression).
  Statut des checks combinés : `pending`, 0 check, 0 statut — rien ne bloque
  ni ne valide techniquement cette PR, c'est une décision de périmètre.
- PR #103 — OUVERTE, non mergée (note de travail KLEAN de la vague 10).
  Branche `klean/alkao-note-2026-10-29`, commit `bf90198`, base main
  `535cd93540ecb71641c04fd1d68e15e92e672a56`.
- Issue #84 — OUVERTE. Titre : « Production: déployer main sur Coolify,
  exposer SHA et valider la base ALKAO ». Créée 2026-10-14. Sa mise à jour du
  2026-10-29T17:08:26Z a été lue cette fois : c'est un seul commentaire
  (commentaire 6503300456, auteur takatakca) : « Sweep GitHub du 2026-10-29 :
  geste humain requis — déployer main sur Coolify, exposer le SHA déployé et
  valider la base ALKAO (tableau de bord Coolify, projet alkao.ca). Aucun
  agent ne peut le faire à la place de l'équipe humaine. — Robot GitHub A
  (Taktak), 2026-10-29 ». Aucune nouvelle donnée technique, aucune case
  cochée dans ce commentaire. Les 6 cases du corps de l'issue restent
  ouvertes selon le texte lu.
- Déploiement effectif de `535cd93` sur alkao.ca : TOUJOURS NON CONFIRMÉ.
  KLEAN n'a aucun accès Coolify et n'a fait aucune vérification en direct
  de alkao.ca/health. La PR #102 automatise un déploiement après CI verte,
  ce n'est pas une preuve que ce déploiement a eu lieu.

## Recommandation confirmée : FERMER LA PR #53 SANS MERGER

Trois raisons vérifiées, inchangées depuis la vague 10 :

1. Périmètre : la revendication concerne le go-live de Havana sur
   billets.promohavana.ca, pas Alkao. Elle n'a pas sa place dans le worklog
   du repo Alkao.ca.
2. Fraîcheur : base vieille de 21 jours (2026-10-08) contre un main à
   `535cd93` ; statut « active » jamais finalisé, contrairement à la promesse
   du corps de la PR (« The line will be updated to its final status before
   the agent stops »).
3. Valeur : la ligne ne prouve rien sur Alkao et son « next step »
   (installer la dernière release MochaHost) date du 2026-10-08.

KLEAN ne ferme PAS la PR #53 elle-même : la fermeture reste une décision
propriétaire. Le texte ci-dessous est prêt à copier-coller par le propriétaire
au moment de la fermeture.

## Texte exact de fermeture proposé pour la PR #53

> Fermée sans merge — hors périmètre Alkao.
>
> Cette PR ajoutait une seule ligne au WORKLOG.md d'Alkao.ca revendiquant le
> go-live de Havana sur billets.promohavana.ca, avec le statut « active »,
> sur une base main du 2026-10-08 jamais mise à jour et un statut final
> jamais renseigné, contrairement à ce que promettait le corps de la PR.
> La revendication concerne Promo Havana, pas Alkao : elle ne doit pas entrer
> dans le worklog d'Alkao.ca.
>
> Si la revendication a encore de la valeur, elle doit être déplacée dans le
> worklog du repo promohavanaca, avec son statut final réel confirmé par le
> propriétaire (go-live réellement arrivé ou non) — et non recopiée avec le
> statut « active » du 2026-10-08. Aucune écriture de cette revendication
> dans Alkao.ca n'est prévue par cette fermeture.
>
> Vérifié par KLEAN le 2026-10-29 : main Alkao
> 535cd93540ecb71641c04fd1d68e15e92e672a56, PR #53 tête d87e7487, base
> 60dea2e du 2026-10-08, diff = 1 ligne WORKLOG.md.

## Proposition de déplacement vers promohavanaca (sans l'écrire dans Alkao)

À faire UNIQUEMENT par le propriétaire (ou l'agent désigné pour
promohavanaca), jamais par KLEAN dans ce repo :

1. Confirmer le statut final réel du go-live Havana sur
   billets.promohavana.ca (arrivé / non arrivé / partiel), avec la date et
   la preuve correspondante. Ne pas recopier « active » sans vérification.
2. Écrire UNE ligne dans le worklog du repo promohavanaca, au format de ce
   worklog, avec ce statut final réel — par exemple, structure à compléter
   par le propriétaire :
   `AAAA-MM-JJ | [agent] | [branche → PR] | [STATUT FINAL RÉEL À CONFIRMER
   PAR LE PROPRIÉTAIRE] | Havana go-live on billets.promohavana.ca
   (MochaHost) | [next step réel]`
3. Si le statut final ne peut pas être confirmé, ne pas déplacer la ligne :
   la laisser tomber avec la fermeture de la PR #53 et le noter dans le
   worklog promohavanaca comme revendication non confirmée, plutôt que de
   propager un « active » périmé.
4. Ne rien écrire de cette revendication dans Alkao.ca, ni dans WORKLOG.md
   ni ailleurs dans ce repo.

## Issue #84 — Liste exacte et vérifiable des étapes propriétaire restantes

Source : corps de l'issue #84 lu intégralement le 2026-10-29, plus son
commentaire du 2026-10-29 (geste humain requis, tableau de bord Coolify,
projet alkao.ca). KLEAN ne déploie rien, ne touche à aucun secret, ne
configure pas Coolify. Chaque étape ci-dessous est à cocher par le
propriétaire, avec preuve, avant de fermer l'issue.

1. Base dédiée : confirmer que la base utilisée appartient à une base
   dédiée à ALKAO, pas au master TAKATAK / FESTI-ICE ; préserver tout
   historique de commandes et de billets existant.
2. Rotation des secrets : faire la rotation des secrets exposés dans
   l'historique public (incident décrit dans `docs/TAKATAK_AGENT_HANDOFF.md`),
   sans jamais copier de valeur dans GitHub, dans un document ou dans un
   rapport.
3. Application Coolify `alkao.ca` : configurer les migrations additives sur
   la bonne base, l'exécution des workers, la provenance du commit et le
   healthcheck `/health/ready` (variables nommées dans le corps de l'issue,
   valeurs à renseigner uniquement dans Coolify, jamais dans GitHub).
4. Redéploiement : redéployer la version actuelle de `main`, puis exiger
   `/health` avec le build correspondant au commit actuel, `/health/ready`
   HTTP 200 et `schema=current` — ou un scénario `unknown` documenté.
5. Parcours public : vérifier la page `/salles`, ses URLs de lieu, la
   version anglaise et le sitemap ; ne rien exposer pour un organisateur
   non autorisé.
6. Go-live documenté : suivre `docs/ALKAO_GO_LIVE.md` et
   `docs/ALKAO_DEPLOY_COOLIFY.md`, puis valider l'intégration Stripe et les
   commandes avant d'activer des ventes réelles.
7. Critère de clôture de l'issue (à vérifier en une fois, avec preuves) :
   commit ALKAO actuel confirmé sur `https://alkao.ca/health`, readiness et
   migrations contrôlées, catalogue privé par défaut, parcours public
   observé — puis autorisation distincte avant d'activer des paiements
   réels. Aucun paiement réel sans cette autorisation distincte.

## Ce qui reste bloqué côté propriétaire (après cette vague)

- Fermeture de la PR #53 (texte ci-dessus prêt, décision et clic
  propriétaire).
- Déplacement éventuel vers promohavanaca, seulement après confirmation du
  statut final réel du go-live Havana.
- Tout le déploiement Coolify de l'issue #84 (base, secrets, appli
  `alkao.ca`, `/health`, `/health/ready`, `/salles`, version anglaise,
  sitemap, Stripe) et l'autorisation distincte avant tout paiement réel.
- Merge éventuel de la PR #103 (note vague 10) et de la présente PR
  (proposition de fermeture) : décision propriétaire uniquement, jamais KLEAN.

— KLEAN, 2026-10-29
