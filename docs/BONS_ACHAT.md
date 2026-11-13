# Bons d'achat de commerces (Run 109)

Un restaurant, un spa, une boutique ou une activité vend un **bon d'achat** sur ALKAO, comme sur Groupon, Tuango ou PromoRabais :

- une **valeur** (« valeur 80 $ ») et un **prix** (« 45 $ ») ;
- une **période de validité** (du… au…) ;
- des **conditions** (les petites lignes : jours, réservation, un bon par table…).

L'acheteur reçoit un **code QR par bon**. Le commerce le scanne **une seule fois**, n'importe quand pendant la période de validité, avec le scanner ALKAO déjà utilisé aux portes des événements (même hors ligne). L'argent va au compte Stripe du commerce. La commission TAKATAK suit les mêmes règles qu'un billet.

Rien n'est inventé : la valeur, le prix, la période et les conditions sont ceux du commerçant. La base de données refuse une valeur égale ou plus basse que le prix.

## Créer un bon dans /ops

1. **Événements → Nouvel événement**, avec le nom de l'offre (« Souper pour deux au Bistro »), la photo et la catégorie.
2. **Page de l'événement** :
   - cocher **Cet événement est un bon d'achat** ;
   - écrire les **Conditions de l'offre**, une par ligne ;
   - **Enregistrer la page**.
3. **Séances** : une seule séance, qui est la période de validité.
   - **Valide à partir du** et **Valide jusqu'au** : la fin est obligatoire pour un bon.
   - **Nombre de bons** : combien seront vendus au total.
   - Puis **Mettre en vente**.
4. **Types de billets** : le nom du bon (« Souper pour deux, entrée, plat, dessert »), son **Prix**, et la **Valeur du bon**, plus élevée que le prix.
   - Plusieurs options sont possibles (« pour deux », « pour quatre »), chacune avec sa valeur.
5. **Publier** l'événement. Pour qu'il paraisse sur alkao.ca : Apparence → **Afficher mes événements sur ALKAO**.

Les autres outils marchent aussi sur un bon :

- prévente et paliers lève-tôt (`PREVENTES_COUPONS.md`) ;
- coupons publics ;
- codes pour entreprises ;
- offre de retour.

## Ce que voit l'acheteur

- **Sur alkao.ca** :
  - la carte porte le badge **Bon** au lieu d'une date, « Valide jusqu'au 31 décembre 2026 », et le ruban **Bon −43 %** ;
  - le prix affiche « À partir de 45 $ + taxes », avec la valeur barrée ;
  - le bon entre dans **Préventes et rabais**. S'il fait économiser le plus par bon, il devient l'offre à la une : prix, valeur barrée et « 35 $ d'économie par bon ».
  - Un bon n'apparaît ni dans « Cette semaine » ni dans l'Agenda, et n'est pas déclaré comme « Event » aux moteurs de recherche : ce n'est pas une sortie à une date.
- **Dans la boutique** :
  - « Bon d'achat · Gastronomie » au-dessus du titre, et « Valide jusqu'au … » au lieu d'une date ;
  - l'encadré de réservation montre la valeur barrée et l'économie ;
  - l'étape 1 s'appelle **Période de validité**. Il n'y a pas de calendrier : la seule période est déjà choisie.
  - La section **Conditions de l'offre** a son onglet.
- **Le courriel et la page des billets** disent « Bon valide jusqu'au … » au lieu d'une date de spectacle.
- **Aucun rappel « à demain »** n'est envoyé pour un bon. Le rappel avant l'expiration est le prochain BESOIN de la feuille de route.

## Côté technique

- **Migration** `20261126000100_alkao_vouchers.sql` :
  - `ticketing_events.voucher` (boolean, faux par défaut) ;
  - `ticketing_ticket_types.value_cents`, avec la contrainte `ticketing_ticket_types_value_ck` : admission seulement, plus élevée que le prix, d'où l'erreur `value_must_exceed_price`.
- **Page** : `page.terms` (texte simple, 3 000 caractères au plus).
- **Vente** :
  - `isSessionSellable` vend la séance d'un bon jusqu'à sa fin ;
  - `listPublicSessions` la liste tant qu'elle n'est pas terminée ;
  - `createSession` refuse une séance de bon sans fin, d'où l'erreur `voucher_needs_end`.
- **Scanner** : la fenêtre d'entrée suit déjà la séance, de son début à sa fin (`ALKAO_SCANNER_V1.md`). Rien n'a changé.
- **Courriels** : `queueReminders` saute les bons, et `ticketsEmail` reçoit `voucherUntil`.
- **Accueil** :
  - `eventDeals` donne `value`, le bon qui fait économiser le plus ;
  - `offerOf` passe de prévente → valeur → coupon ;
  - un coupon en montant ne passe jamais devant un pourcentage.
- **Importation** : `npm run events:import` accepte `"voucher": true` sur l'événement, `"valueCents"` sur un billet et `page.terms`.
- **Tests** :
  - `test/api/vouchers.test.ts` (5) : fin obligatoire, valeur gardée au-dessus du prix, vente pendant la période et pas après, affichage sur alkao.ca, courriel, aucun rappel, copie d'un événement ;
  - `test/ui/voucher-ui.test.ts` : la boutique dans Chromium, sur ordinateur et téléphone.
