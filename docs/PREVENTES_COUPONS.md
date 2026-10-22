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

**Modifier** : dans le tableau des types de billets, la colonne **Prévente** permet de changer la date de fin et la quantité. La quantité ne peut pas descendre sous ce qui est déjà vendu ou réservé. Pour arrêter la prévente tout de suite, cliquez **Retirer de la vente**.

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

**Prévente et coupon ensemble** : le coupon s'applique aussi aux billets de prévente. Si vous ne voulez pas les cumuler, n'activez pas de coupon public pendant la prévente.

## Catégories

Les nouvelles catégories, dans /ops → Fiche de l'événement → Catégorie :

- **Gastronomie** : fêtes gourmandes, bières et vins, cuisine de rue ;
- **Mode** : ventes trottoir, friperies, défilés, boutiques éphémères ;
- **Marchés et salons** : marchés, foires, salons, artisans.

Elles ont leur propre filtre et leur propre photo sur alkao.ca.

## Côté technique

- **Migration** : `20261120000100_alkao_presales_coupons.sql`.
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
