# Préventes et coupons rabais (Run 97)

ALKAO vend tout événement d'une à quelques journées : un festival, une fête gastronomique, une vente de vêtements, un marché ou un salon. Deux outils vendent plus tôt et plus :

- **le prix de prévente**, un prix plus bas pour un temps ou une quantité limités ;
- **les coupons**, des codes promo affichés à tous les acheteurs, qu'ils appliquent en un clic.

Tout se fait dans **/ops**, sur la page de l'événement. Rien n'est inventé : chaque prix, rabais et date affichés est celui que vous avez entré.

Pour un événement de plusieurs jours, la **passe festival** vend toutes les dates en un seul billet : voir `PASSES_FESTIVAL.md`.

## Le prix de prévente

**Créer** : /ops → Événements → votre événement → **Types de billets** → **Prix de prévente**.

1. Choisissez le **billet régulier**, par exemple « Adulte, 25 $ ».
2. Entrez le **prix de prévente**, par exemple 20 $. Il doit être plus bas que le prix régulier : ALKAO refuse un prix égal ou plus élevé.
3. Donnez **une fin** : une date, une quantité (« les 200 premiers », toutes séances comprises), ou les deux. Une prévente sans fin est refusée.
4. **Créer la prévente.** Un billet « Adulte — Prévente » est ajouté et mis en vente.

**Ce que voit l'acheteur** :

- **Sur la page de l'événement**, juste avant le billet régulier : le badge **Prix prévente**, le rabais (« −20 % »), le prix régulier barré, la date de fin et ce qui reste (« Plus que 12 à ce prix »).
- **En haut de la page** : « Prix prévente 20 $ ~~25 $~~ −20 % · jusqu'au 1er novembre ».
- **Dans les 48 dernières heures** (Run 101), la date devient un compte à rebours : « Se termine dans 5 h 12 min ». Il suit la vraie date de fin, sans jamais la repousser. À la fin, la page se met à jour d'elle-même : la prévente disparaît et le prix régulier reste.
- **Sur alkao.ca** : le badge **Prévente −20 %** sur la carte de l'événement.
  - Le rabais est arrondi vers le bas : jamais plus que la réalité.
  - À partir de quatre événements, une rangée **Préventes et rabais** les regroupe.

**Quand la prévente se termine**, à sa date ou quand sa quantité est vendue :

- le billet prévente disparaît de la page, et le billet régulier reste seul en vente ;
- il ne compte plus dans le prix « À partir de ».

**Ce que la base de données garantit** :

- La quantité vaut pour tout l'événement, toutes séances ensemble :
  - un panier qui la dépasserait est refusé (« Les billets à ce prix viennent de s'épuiser ») ;
  - un paiement déjà fait n'est jamais refusé.
- Un panier abandonné libère ses billets dès son expiration, même avant le nettoyage automatique.
- Un remboursement complet remet ses billets en vente.
- Le prix régulier ne peut pas descendre au prix de prévente, ni plus bas.

**Des paliers de prix** (Run 104) : plusieurs préventes à la suite, par exemple **Lève-tôt** à 20 $ jusqu'au 1er novembre, puis **Prévente** à 25 $ jusqu'au 15, puis le prix régulier.

1. Créez la première avec son nom (« Lève-tôt »), son prix et sa fin.
2. Créez la seconde avec son nom (« Prévente »), son prix, un **Début** égal à la fin de la première, et sa propre fin.
3. Avant son début, un palier n'est **jamais vendu**. La boutique l'annonce sur la ligne en cours : « Ensuite : 25,00 $ ». La date s'ajoute si le palier ne commence pas pile à la fin du précédent.
4. À l'heure du changement, la page se met à jour d'elle-même : le nouveau palier remplace l'ancien, sur la boutique comme sur alkao.ca.

**Modifier** : dans le tableau des types de billets, la colonne **Prévente** permet de changer le début, la date de fin et la quantité. La quantité ne peut pas descendre sous ce qui est déjà vendu ou réservé. Pour arrêter la prévente tout de suite, cliquez **Retirer de la vente**.

Un événement dupliqué garde ses préventes. Leur date de fin est décalée avec les séances.

## Les coupons

**Créer** : /ops → votre événement → **Codes promo**.

1. Entrez le code (« PREVENTE15 ») et le rabais, en pourcentage ou en montant.
2. Au besoin, ajoutez le nombre d'utilisations et la fin.
3. Cochez **Coupon public**.
4. Donnez-lui un nom, par exemple « Coupon prévente ».

Le rabais s'applique avant les taxes. La commission TAKATAK se calcule sur le montant réduit.

**Ce que voit l'acheteur** :

- Le coupon s'affiche dans le panneau des billets : le rabais, son nom, sa fin, les utilisations qui restent, et un bouton **Appliquer**.
- Sur alkao.ca, l'événement affiche **Coupon −15 %**, si aucune prévente n'est en cours.

**Le lien du coupon** : dans la ligne du code, cliquez **Copier le lien du coupon**. Le coupon s'applique à l'arrivée sur la page. Partagez ce lien dans une publication, une infolettre ou un code QR imprimé.

**Un code privé** (case non cochée) reste un code qu'on vous donne : partenaires, membres, employés. Il n'apparaît nulle part. Dans la ligne du code, **Rendre privé** et **Montrer comme coupon** font passer un code d'un état à l'autre.

**Prévente et coupon ensemble** : par défaut, le coupon s'applique aussi aux billets de prévente. Pour ne pas les cumuler (Run 99), cochez **Non cumulable avec la prévente** en créant le code, ou cliquez **Rendre non cumulable** dans sa ligne :

- le code ne réduit alors que les billets au prix régulier du panier ; les billets en prévente gardent leur prix ;
- sur un panier de billets en prévente seulement, le code est refusé avec la raison : « Ce code ne s'applique pas aux billets en prévente » ;
- pendant la prévente, le coupon affiche « hors prix prévente ».

Le serveur fait ce calcul à chaque étape (devis, panier, paiement) : le montant payé est toujours celui affiché.

## Les codes pour les entreprises (Run 103)

Un commanditaire, un employeur ou un commerce partenaire distribue vos billets à prix réduit : à ses employés, à ses membres, à ses clients. Chacun reçoit son propre code. Vous gagnez des acheteurs sans payer de publicité, l'entreprise offre un avantage, et l'acheteur économise.

**Créer** : /ops → votre événement → **Codes pour les entreprises**.

1. Le nom de l'entreprise, par exemple « Caisse Desjardins de Valleyfield ».
2. Le **nombre de codes** (jusqu'à 2 000) et les **utilisations par code**. 1, c'est un code par personne. Plus, c'est un code pour une famille ou une équipe.
3. Le rabais (en pourcentage ou en montant), au besoin une date de fin, et **Non cumulable avec la prévente**.
4. **Créer les codes.** Chaque code commence par le nom de l'entreprise, par exemple `CAISSEDE-7KQ2MX`. Il n'utilise aucun caractère qu'on confond à la lecture (0 et O, 1, I et L).

**Envoyer** : **Télécharger les codes (CSV)**. Le fichier donne, pour chaque code :

- le rabais, les utilisations et ce qui a déjà servi ;
- la date de fin ;
- **son lien personnel vers la boutique**, qui applique le code à l'arrivée.

L'entreprise envoie un lien par personne, par courriel ou sur son intranet.

**Ce que voit l'acheteur** : « Code CAISSEDE-7KQ2MX appliqué · **Offre Caisse Desjardins de Valleyfield** ». Un code d'entreprise n'est jamais affiché comme coupon public, ni sur la page ni sur alkao.ca.

**Arrêter** : **Désactiver tous** coupe tous les codes de l'entreprise d'un coup, et **Réactiver tous** les remet.

**Les résultats** : dans le tableau de bord, l'entreprise a sa propre ligne dans « Codes promo et coupons » : les codes utilisés, les commandes, le rabais accordé, le montant payé et le remboursé.

## L'offre de retour (Run 105)

Un client qui a aimé revient, surtout avec une raison de le faire. Chaque acheteur reçoit, avec ses billets, un rabais pour votre prochain événement.

**Choisir** : /ops → votre événement → **Offre de retour** → **Code offert**.
- Prenez un code d'un autre de vos événements (« RETOUR15 » sur le Festival d'hiver), ou de celui-ci pour une autre date.
- Les codes des entreprises n'y figurent pas : ils restent à l'entreprise.

**Ce que voit l'acheteur** :
- Sur la page de ses billets, la carte **Votre prochaine sortie** : le rabais, l'événement, le code et sa fin. Le bouton **Voir l'événement** ouvre la boutique avec le code déjà appliqué.
- Dans le courriel de ses billets : « Merci ! −15 % sur Festival d'hiver avec le code RETOUR15. », avec le même lien.

**Quand elle se montre** : seulement si le code est utilisable et que son événement a une date en vente. Le code doit être actif, commencé, ni terminé ni épuisé. Sinon, rien ne s'affiche, sans rien à retirer : l'offre revient d'elle-même quand le code redevient utilisable. Dans /ops, la phrase sous le choix dit si elle est montrée.

**Ses résultats** : le code est un code promo ordinaire. Ses ventes paraissent dans le tableau de bord, sous « Codes promo et coupons ».

## Les résultats (Run 101)

/ops → **Tableau de bord** → **Détail des ventes** :

- **Par type de billet** : chaque billet de prévente porte le badge **Prévente** et chaque passe le badge **Passe festival**, avec la quantité vendue et le revenu.
- **Codes promo et coupons** : pour chaque code, le nombre de commandes, le rabais accordé (avant taxes), le montant payé et ce qui a été remboursé. Un coupon public y est séparé d'un code privé.

Les filtres de période et d'événement s'appliquent à ces tableaux comme au reste du rapport.

## Charger par fichier (Run 99)

`npm run events:import` charge un événement complet depuis un fichier JSON (voir `HAVANA_SUR_ALKAO.md`). Le fichier peut maintenant contenir :

- **une prévente** : un billet avec `presaleOfCode` (le code du billet régulier), un prix plus bas, et `salesEndAt`, `quantityLimit` ou les deux ;
- **une passe festival** : un billet avec `"pass": true` (voir `PASSES_FESTIVAL.md`) ;
- **des coupons** : une liste `promoCodes`, avec `code`, `kind` (`percent` ou `amount`), `percent` ou `amountCents`, et au besoin `public`, `label`, `endsAt`, `maxUses` et `excludesPresales`.

Comme le reste du fichier, un billet ou un code qui existe déjà (même code) est gardé tel quel. Une prévente qui nomme un billet absent de l'événement est refusée.

## Catégories

Les nouvelles catégories, dans /ops → Fiche de l'événement → Catégorie :

- **Gastronomie** : fêtes gourmandes, bières et vins, cuisine de rue ;
- **Mode** : ventes trottoir, friperies, défilés, boutiques éphémères ;
- **Marchés et salons** : marchés, foires, salons, artisans.

Elles ont leur propre filtre et leur propre photo sur alkao.ca.

## Côté technique

- **Migrations** :
  - `20261120000100_alkao_presales_coupons.sql` ;
  - `20261122000100_alkao_coupon_excludes_presales.sql` (Run 99) : `excludes_presales` sur `ticketing_promo_codes` ;
  - `20261123000100_alkao_partner_codes.sql` (Run 103) : `partner` sur `ticketing_promo_codes`, et une contrainte qui garde ces codes privés ;
  - `20261124000100_alkao_price_phases.sql` (Run 104) : `sales_start_at` sur les types de billets ;
  - `20261125000100_alkao_return_offer.sql` (Run 105) : `return_offer_promo_id` sur `ticketing_events`.
  - Sur `ticketing_ticket_types` : `presale_of`, `sales_end_at` et `quantity_limit`.
  - Une nouvelle table de comptage, `ticketing_ticket_type_counts`, réservée au serveur.
  - Sur `ticketing_promo_codes` : `public` et `label`.
  - Les trois catégories.
- **Routes** :
  - `GET /v1/public/…/events/:id` donne, pour chaque billet, `presaleOf`, `salesEndAt`, `quantityLimit` et `remaining`, et la liste `coupons` ;
  - les routes de création et de modification des billets et des codes promo acceptent les nouveaux champs.
- **Tests** :
  - `test/payments/presale-coupons.test.ts`, `test/api/home-deals.test.ts` et le test Run 97 de `test/api/home.test.ts` ;
  - `test/ui/presale-ui.test.ts` (boutique et alkao.ca) et `test/ui/presale-ops.test.ts` (/ops).
