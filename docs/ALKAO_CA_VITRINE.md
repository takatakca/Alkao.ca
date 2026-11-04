# alkao.ca : ce qui apparaît, et le filtre « Passés » (Run 106)

## Pourquoi mon événement n'apparaît pas dans « À venir »

alkao.ca affiche un événement seulement si **les cinq conditions** sont vraies. Une seule manque, et il n'apparaît pas.

1. **L'organisateur s'affiche sur alkao.ca.** /ops → Apparence → section ALKAO → cocher **Afficher mes événements sur ALKAO**, puis Enregistrer.
2. **La billetterie est active pour cet organisateur.** C'est le réglage de TAKATAK (abonnement Billetterie) et celui du serveur ALKAO. Sans eux, rien d'un organisateur ne s'affiche.
3. **L'événement est Publié.** Un événement en **Brouillon** ne s'affiche nulle part. /ops → Événements → l'événement → **Publier**.
4. **La vente est ouverte.** Avant la date d'ouverture des ventes, ou après leur fermeture, l'événement n'est pas listé.
5. **Il reste au moins une date à venir, En vente, avec des places.** Une date passée, en pause, annulée ou complète ne compte pas.

Le cas de Havana :
- Halloween avait deux dates, les 24 et 31 octobre. Selon `CE_SOIR_HAVANA.md`, il était encore en Brouillon le 22 octobre, et la vente se faisait sur Weezevent.
- Le 4 novembre 2026, alkao.ca ne montre aucun événement en vente. Les deux dates d'Halloween sont passées, donc la condition 5 ne peut plus être vraie pour lui.
- Pour qu'il apparaisse dans « Passés », il doit être Publié (condition 3) et l'organisateur doit s'afficher sur alkao.ca (condition 1).

Pour que Havana apparaisse : créer le prochain événement dans /ops, avec ses dates et ses prix, le **Publier**, et cocher **Afficher mes événements sur ALKAO**.

## Le filtre « Passés »

La barre de filtres d'alkao.ca offre **À venir** et **Passés**, chacun avec son nombre d'événements.

« Passés » montre les événements de l'année écoulée, le plus récent en premier :
- d'un organisateur qui s'affiche sur alkao.ca (conditions 1 et 2) ;
- **publiés** (jamais un brouillon) ;
- dont **toutes** les dates sont passées, la dernière dans les 12 derniers mois ;
- avec au moins une date qui a eu lieu (une date annulée ne compte pas).

Une carte « Passés » affiche « Terminé », la dernière date et le nombre de dates. Son bouton **Voir l'événement** mène à la page de l'événement. Elle n'a ni prix ni bouton d'achat. Les événements passés n'entrent pas dans la recherche rapide, les favoris, le plan du site ni les données pour Google.

Quand rien n'est à venir mais que des événements passés existent, la page le dit (« Aucun événement à venir pour le moment ») et offre **Voir les événements passés (N)**.

## La barre de filtres

- **À venir / Passés**, avec le nombre d'événements de chaque côté.
- **Quand** (aujourd'hui, cette fin de semaine, cette semaine, ce mois-ci) : seulement les choix qui ont des dates.
- **Catégorie** : seulement les catégories qui ont des événements.
- **Prix** et **Trier par** : pour ce qui est en vente seulement.
- **Organisateurs** : quand il y en a plus d'un.
- **Grille / Agenda** : pour ce qui est en vente seulement.
- Chaque filtre actif devient une puce. Un toucher sur la puce l'enlève, et **Tout effacer** les enlève tous.
- Sur un ordinateur, la barre reste visible pendant qu'on fait défiler les événements.
- Tout fonctionne sans JavaScript : chaque choix est un lien.

## Côté technique

- `src/db/catalog.ts` `listPastEvents` :
  - ne compte aucune date en brouillon ou annulée ;
  - exige que la dernière date soit passée et date de moins d'un an ;
  - garde 24 événements par organisateur et les 6 dernières dates de chacun.
- `src/api/app.ts` : `HomeBrand.past`. Un organisateur qui n'a que du passé est listé.
- `src/api/home-view.ts` :
  - le paramètre `?periode=passes` ;
  - `ask`, la recherche sans date, prix, tri ni agenda dans « Passés » ;
  - `pastCard`, la barre de filtres et les puces actives.
- Tests :
  - `test/api/home-past.test.ts` (5) : brouillon, date annulée, plus d'un an, date encore à venir et organisateur non affiché exclus. Une mutation de la règle « annulée » fait échouer 4 tests ;
  - `test/ui/home-past-ui.test.ts` (2) : Chromium, sur ordinateur (barre qui reste visible) et sur téléphone (aucun débordement, puce retirée d'un toucher).
