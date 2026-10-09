# Domaines et fournisseurs

Aide-mémoire : chez qui se trouve chaque domaine, pour savoir où aller avant de toucher aux
DNS (Resend, sous-domaine de billetterie, vérification d'un service). Une ligne par domaine.
Ne rien inscrire qui n'a pas été confirmé, et jamais de mot de passe ni de clé.

| Domaine | Fournisseur | Confirmé | Notes |
|---|---|---|---|
| `festi-ice.ca` | **IONOS** (le domaine) | Le propriétaire, 2026-10-09 | Un changement DNS sur festi-ice.ca commence chez IONOS : vérifier là-bas vers quels serveurs de noms le domaine pointe. Ce n'est pas MochaHost. |
| `promohavana.ca` | Site hébergé sur MochaHost (cPanel) | Flux de déploiement du dépôt `promohavanaca` | Registraire du domaine à confirmer. |
| `alkao.ca` | À confirmer | — | — |

Pour ajouter ou corriger une ligne : une PR qui modifie ce fichier, avec la date et la personne
qui a confirmé.
