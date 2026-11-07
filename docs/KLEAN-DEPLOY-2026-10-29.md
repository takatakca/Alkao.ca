# KLEAN — Déploiement 4/10 — alkao.ca — 2026-10-29

Mission déploiement KLEAN 4/10, 2026-10-29 vers 17:14 EDT. Signé KLEAN. Aucun secret, mot de passe ou code dans cette note (noms de secrets seulement).

## Carte de déploiement — alkao.ca

- Cible : Coolify, application alkao.ca (selon docs repo).
- Main avant : 535cd93540ecb71641c04fd1d68e15e92e672a56 (merge PR #102, auto-déploiement en code).
- Main après (vérifié) : 9e2a83826a555329b2d1882b8dae44e72aab118f.
- Config présente : OUI (.github/workflows/deploy.yml, verify-deploy.yml, docs/ALKAO_DEPLOY_COOLIFY.md). Après CI verte sur main, POST webhook Coolify avec token Deploy seulement ; Auto Deploy Coolify volontairement OFF.
- Auto-déploiement activé : EN CODE OUI, activation réelle NON VÉRIFIABLE par KLEAN (présence effective des secrets repo et état Coolify non vérifiables sans accès Coolify / paramètres repo ; KLEAN n en a pas). Ne pas affirmer que l auto-déploiement fonctionne.
- PR mergées dans cette mission (autorisation client 17:14 EDT) : #103 (SHA 485faf90971ffeddad8294089cd33d6aa3d175fa, docs seulement) et #104 (SHA 9e2a83826a555329b2d1882b8dae44e72aab118f, docs seulement, après passage brouillon -> prête). PR #53 FERMÉE SANS MERGE avec le texte exact préparé dans #104 (commentaire 6508705803). PR ouvertes Alkao après mission : 0.
- Checklist propriétaire : (1) Coolify : application alkao.ca dédiée, pointe sur main, healthcheck /health/ready. (2) GitHub Settings -> Secrets and variables -> Actions : confirmer la présence (sans valeur) de COOLIFY_WEBHOOK et COOLIFY_TOKEN (Deploy seulement). (3) Déployer main, exiger /health avec le SHA de main et /health/ready 200, valider la base dédiée ALKAO (issue #84). (4) Rotation des secrets exposés dans l historique public, sans valeur dans GitHub ni document.
- État en ligne réel : alkao.ca répond (billetterie, lecture 2026-10-29 21:17 UTC) mais SANS SHA sur la page d accueil — déploiement de 535cd93 puis de 9e2a838 NON CONFIRMÉ en ligne. Un merge n est PAS une preuve de mise en ligne.

## Co-work (rappel, repo distinct)

- Main c097ff1 inchangé ; preview Coolify gated, pas de bascule publique tant que #3 n est pas verte ; CI #7 bloquée côté compte (voir checklist dans la note Drive et la PR co-work correspondante). Aucun fix code ne débloque #7.

Signé : KLEAN — 2026-10-29.
