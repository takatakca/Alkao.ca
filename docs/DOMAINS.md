# Domaines et fournisseurs

Aide-mémoire : chez qui se trouve chaque domaine, pour savoir où aller avant de toucher aux
DNS (Resend, sous-domaine de billetterie, vérification d'un service). Une ligne par domaine.
Ne rien inscrire qui n'a pas été confirmé (par le propriétaire ou par le DNS, avec la date),
et jamais de mot de passe ni de clé.

| Domaine | Fournisseur | Confirmé | Notes |
|---|---|---|---|
| `festi-ice.ca` | **IONOS** (le domaine) | Le propriétaire, 2026-10-09 | Un changement DNS sur festi-ice.ca commence chez IONOS : vérifier là-bas vers quels serveurs de noms le domaine pointe. Ce n'est pas MochaHost. |
| `promohavana.ca` | Site sur le serveur Coolify (`coolify.takatak.ca`, 31.220.96.134), comme `essai.promohavana.ca` | DNS vu le 2026-10-13 | Avant, MochaHost (cPanel). Registraire du domaine à confirmer. |
| `billets.promohavana.ca` | ALKAO sur MochaHost (Passenger, 209.42.24.127) | DNS vu le 2026-10-13 | Ancienne version d'ALKAO. Le déplacer : `docs/ALKAO_DEPLOY_COOLIFY.md`. |
| `alkao.ca` | ALKAO sur le serveur Coolify (31.220.96.134) | DNS vu le 2026-10-13 | Registraire à confirmer. |

Pour ajouter ou corriger une ligne : une PR qui modifie ce fichier, avec la date et la personne
qui a confirmé.
