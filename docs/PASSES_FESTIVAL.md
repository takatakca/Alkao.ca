# Passes festival (Run 98)

Un festival, une fête gastronomique, un marché de fin de semaine : l'événement dure deux ou trois jours, une séance par jour. La **passe festival** est un seul billet, avec un seul code QR, valide à chacune de ces dates.

## Créer une passe

/ops → Événements → votre événement → **Types de billets** :

1. Code (`PASSE_3J`), nom (« Passe festival — 3 jours ») et prix.
2. Genre **Admission**, puis cochez **Passe festival (toutes les dates)**.
3. **Ajouter.** Le tableau affiche « Admission · passe festival ».

Une passe ne peut pas être un billet ouvert ni une option : ALKAO refuse.

Une prévente de la passe se crée comme les autres, avec **Prix de prévente** (voir `PREVENTES_COUPONS.md`). Elle reste une passe.

## Ce que voit l'acheteur

- **En haut de la page de l'événement** : « Passe festival 74,95 $ · Les 3 dates ». Un clic ouvre la passe dans le panneau des billets.
- **Dans le panneau** : un choix entre **Billet d'un jour** et **Passe festival**.
  - En mode passe : la liste des dates couvertes, « Une entrée par date, avec le même code QR » et le nombre de passes qui restent.
  - Un événement qui ne vend que des passes s'ouvre directement sur la passe.
- **Le prix** de la passe est celui que vous avez entré. ALKAO n'affiche aucune économie inventée par rapport aux billets d'un jour.
- **Sur la page des billets** : la première date sur le talon, puis « Valide aussi » et les autres dates.
- **Ajouter à mon calendrier** ajoute une entrée par date.

## Ce que la base de données garantit

- **Toutes les dates.** La passe prend une place à chaque date en vente au moment de l'achat.
  - Si une seule de ces dates est complète, la passe est refusée (« Il ne reste plus assez de places ») ;
  - aucune date n'est vendue au-delà de sa capacité.
- **Un panier abandonné** libère ses places sur toutes les dates. Elles redeviennent disponibles dès son expiration, avant même le nettoyage automatique.
- **Un remboursement** ou une annulation de la passe rend sa place à chaque date.
- **Une passe s'achète seule.** Un panier qui mélange une passe et des billets d'un jour est refusé, et les options ne s'ajoutent pas à une passe.
- **À l'entrée**, le même code QR entre une fois par date :
  - un deuxième passage le même jour donne « Déjà entré » ;
  - un billet d'un jour, lui, n'entre qu'à sa propre date.
- **Les scanners hors ligne** de chaque date connaissent les passes : celles déjà entrées et celles à venir.
- **La recherche par numéro de commande** à la porte montre l'entrée de la date en cours.

## Ce qu'une passe ne fait pas

- **Elle ne change pas de séance** : elle est déjà valide à toutes ses dates.
- **Elle ne se transfère pas.**
- **Annuler une date** (orage, par exemple) rembourse les billets d'un jour de cette date, pas les passes, qui restent valides aux autres dates.

## Côté technique

- **Migration** : `20261121000100_alkao_festival_passes.sql`.
  - `ticketing_ticket_types.pass` ;
  - `ticketing_hold_pass_seats` : les places d'un panier sur les autres dates ;
  - `ticketing_ticket_pass_seats` : les dates d'un billet payé, en plus de la sienne ;
  - une admission par billet et par séance (`ticketing_scans_one_admission`).
- **Verrous.** Ils suivent l'ordre des dates, à la création comme à la libération. Deux paniers ne s'attendent jamais l'un l'autre en sens inverse.
- **Routes.**
  - `POST /v1/public/…/holds` : avec une passe, le panier appartient à la première date vendable, peu importe la date envoyée. La réponse donne `passSessionIds` ;
  - `GET /v1/public/…/orders/:id` : `passDates` par billet ;
  - codes d'erreur : `pass_cart_mixed` (422), `pass_no_session`, `pass_cannot_change_session` et `pass_not_transferable` (409).
- **Tests** : `test/scanner/festival-pass.test.ts` (capacité, entrée, scanners hors ligne, annulation, remboursement, panier abandonné) et `test/ui/festival-pass-ui.test.ts` (boutique, page des billets, téléphone).
