# ALKAO face aux grandes billetteries — banc d'essai et écarts

Date : 2026-10-13. Pages publiques seulement, sans connexion. ALKAO lu dans `README.md` (Runs 01–63), `docs/` et la PR #76 (accueil).

## Résumé

- ALKAO est déjà au niveau des grands sur l'arrière-boutique : paiement Stripe Connect, scan hors ligne signé, remboursements automatiques, rapports TPS/TVQ, courriel et SMS sous la LCAP, Loi 25.
- Le prix est déjà clair : aucuns frais ajoutés, prix + taxes. C'est la règle « tout inclus » de l'OPC, et c'est mieux que Eventbrite (frais à l'acheteur par défaut).
- Les vrais écarts sont côté acheteur : Wallet, transfert à un ami, liste d'attente, prévente, compte, plan de salle.
- evenko vend ses billets par Ticketmaster. Il montre surtout une découverte riche : genre, salle, âge, langue, portes, stationnement.
- Deux points légaux à régler vite : la politique de remboursement avant le paiement, et l'avis automatique quand l'organisateur change la date, l'heure ou le lieu (obligatoire depuis le 12 sept. 2026).

## Repères légaux (Québec)

- **Prix tout inclus (OPC).** Le prix annoncé comprend tous les frais (service, livraison obligatoire). Seules la TPS et la TVQ peuvent s'ajouter. Le total doit ressortir plus que ses parties. Interdit d'annoncer seulement un versement sans le coût total [L1]. Ticketmaster affiche le prix tout inclus au Canada [T2].
- **Revente (en vigueur le 12 sept. 2026).** Avis « revente » dès l'entrée sur la plateforme. Nom du dernier propriétaire, prix de la billetterie officielle et ventilation des frais avant l'achat. Au-dessus du prix officiel : accord écrit du producteur (et du diffuseur) [L2][L3][L7]. Ticketmaster affiche le nom du vendeur pour le Québec depuis le 8 sept. 2026 [T4].
- **Événement changé.** Le vendeur doit informer l'acheteur au plus vite d'une annulation ou d'un changement d'horaire ou de lieu [L2].
- **Vente en ligne.** Avant le contrat : coordonnées, prix détaillé, taxes, total, et conditions d'annulation, d'échange ou de remboursement, faciles à conserver [L4].
- **Cartes-cadeaux.** Une carte qui vaut de l'argent ne peut pas avoir de date d'expiration. Pas de frais d'activation [L5][L6].
- **Abonnements en ligne.** Il faut un bouton de résiliation facile à trouver (12 sept. 2026) [L2].
- **Langue (Charte, loi 96).** Catalogues et bons de commande en français, quel que soit le support. Une autre version ne peut pas être plus facile d'accès [L8]. ALKAO est en français par défaut (Run 16).
- **Loi 25.** Les outils qui identifient, localisent ou profilent (pixels publicitaires) sont désactivés par défaut [L9].
- **LCAP.** Messages commerciaux avec consentement et désabonnement (déjà fait : Runs 42, 44, 46).
- **Accessibilité.** Je n'ai trouvé aucune règle WCAG québécoise pour les entreprises privées (à vérifier). La Carte accompagnement loisir (CAL) donne l'entrée gratuite à l'accompagnateur chez les partenaires [L10].

## Tableau comparatif — acheteur

Ticketmaster.ca inclut Admission : admission.com redirige vers `ticketmaster.ca/?lang=fr-ca` (vu le 2026-10-13). evenko : boutons « Acheter » vers ticketmaster.ca (`brand=evenko`) [E1]. « Non vu » : rien trouvé dans les pages publiques, ce qui ne prouve pas l'absence.

| Fonction | Ticketmaster.ca | evenko | Point de vente | Showpass | Eventbrite | ALKAO |
|---|---|---|---|---|---|---|
| Prix et frais | Tout inclus au Canada [T2] | Via TM | Total tous frais inclus ; 0,79 $ + 2 % (+2,9 %) [P4] | Frais affichés d'avance ; organisateur les absorbe ou non [S2] | Frais payés par l'acheteur par défaut : 3,7 % + 1,79 $ + 2,9 % [B2] | Oui : aucuns frais ajoutés, prix + taxes |
| Recherche et filtres | Carte interactive + filtres [T8] | Recherche, recherches récentes, Événements / Festivals / Salles [E1] | Mot-clé + ville + rayon en km [P1] | Date + ville [S0] | Catégories, aujourd'hui, fin de semaine, villes [B1] | Oui (PR #76) : quoi, où, quand, catégorie ; catégories devinées par mots-clés |
| Pages salle / artiste | Favoris artistes et salles [T10] | Pages Salles, infos artiste [E1][E2] | Non vu | Non vu | Suivre l'organisateur [B4] | Partiel : boutique par Brand ; pas de page salle |
| Plan de salle | Oui [T8] | Via TM | Oui [P2] | Oui (forfait Professional) [S2] | Oui [B2] | Non (capacité par séance) |
| Billets accessibles | Bouton « Billets accessibles », ligne tél. [T8] | Via TM | Non vu | Non vu | Non vu | Partiel : pages WCAG 2.1 AA (Run 17) ; pas d'accompagnateur |
| Prévente, code d'accès | Oui [T10] | Dates de prévente, pré-inscription (données) [E1] | Tarifs protégés par mot de passe [P2] | Billets protégés par mot de passe [S1] | Non vu | Non (codes promo seulement, Run 36) |
| File d'attente virtuelle | Oui [T11] | Champ `waiting_room` (données) [E1] | Oui [P5] | Oui [S1] | Non vu | Non (pas de survente, Run 15) |
| Liste d'attente (complet) | Non vu | Non vu | Non, dit clairement [P9] | Oui [S4] | Oui [B2] | Non |
| Transfert à un ami | Oui, gratuit, nouveau code [T3] | Via TM | Oui, illimité [P7] | Oui, une fois [S5] | Changement de nom seulement [B3] | Non |
| Revente entre fans | Oui + Échange au prix coûtant [T4][T5] | Via TM | Non vu | Si l'organisateur l'active [S3] | Non vu | Non |
| Échange, changement de date | Oui, frais possibles [T12] | Via TM | Selon l'organisateur [P5] | Échanges libre-service [S1] | Libre-service si activé [B5] | Oui : changer de séance, billet ouvert (Runs 06, 37) |
| Apple / Google Wallet | Oui [T7] | Via TM ; billets dans l'app Osheaga [E4] | Oui [P6] | Oui [S6] | Apple Wallet (selon l'aide) [B4] | Non |
| App mobile | Oui [T7] | App Osheaga [E4] | App de validation (organisateur) [P2] | App acheteur iOS / Android [S1] | Oui [B4] | Non (web ; `/billets` hors ligne, Run 51) |
| Billet sans réseau | Wallet ; code rotatif SafeTix [T7][T13] | Via TM | Courriel, poste, bracelet, RFID [P2] | Code QR universel [S1] | Non vu | Oui : QR signé dans le courriel et page hors ligne (Runs 51–52) |
| Apple Pay / Google Pay | Oui [T1] | Via TM | Non vu [P8] | Non vu | Non vu | Probable via Stripe Checkout (carte) [X1] — à vérifier |
| PayPal, versements | PayPal, Venmo [T1] ; versements : non confirmé au Canada | Via TM | PayPal selon l'organisateur [P8] | Achetez maintenant, payez plus tard (Premium) [S2] | Non vu | Non |
| Assurance billet | Allianz [T6] | Via TM | Incertain (« ristournes » de partenaires) [P2] | Non vu | Non vu | Non |
| Cartes-cadeaux | Oui, sans expiration [T9] | Non vu | Oui, par organisateur [P1] | Oui [S1] | Non vu | Non |
| Favoris, suivre, alertes | Favoris + alertes de prévente [T10] | Non vu | Non vu | Infolettre [S0] | Suivre les organisateurs [B4] | Partiel : favoris sur l'appareil (PR #76) ; infolettre double opt-in par Brand (Run 44) |
| Rappel, calendrier | Non vu | Non vu | Ajout au calendrier [P5] | Non vu | Rappels automatiques [B2] | Oui : rappel 24 h, `.ics` (Runs 23, 31) |
| Compte, retrouver ses billets | Compte (My Tickets) [T3] | Via TM | Mon compte [P1] | Page des commandes [S3] | « Find my tickets » + compte [B1] | Partiel : lien personnel + « Retrouver mes billets » (Run 27) ; pas de compte |
| Français / anglais | Oui ; aide en fr-ca par défaut | Oui [E1] | Oui [P1] | Oui (`/fr`) [S0] | Oui (Canada FR) [B1] | Oui (Run 16) |
| Soutien | Fan Support, ligne accessibilité [T8] | Courriel + tél. sans frais [E3] | Centre d'aide, tutoriels [P5] | Clavardage, tél., courriel [S1] | Clavardage 24/7 (événements payants) [B2] | Partiel : assistant FAQ à règles (PR #76), coordonnées de la Brand (Run 50) |

Autres repères : DICE montre le prix complet d'avance, a une liste d'attente pour les spectacles complets et permet de suivre des artistes [D1][D2]. Ticketpro offre l'adhésion VIP pour les préventes, un centre d'appels et une politique d'accessibilité [K1].

## Tableau comparatif — organisateur

evenko est un promoteur sur Ticketmaster : il n'a pas de colonne ici. Ses données d'événement montrent stationnement, hébergement, restaurants et expériences premium [E1][E2].

| Fonction | Ticketmaster | Point de vente | Showpass | Eventbrite | ALKAO |
|---|---|---|---|---|---|
| Création, séances | TM1 [T17] | Oui [P2] | Entrées à heure fixe, calendrier [S1] | Création par IA [B2] | Oui : séances en lot, duplication (Runs 28–29) |
| Prix dynamiques | Platinum, Pricemaster [T14] | Non vu | Non vu | Non vu | Non |
| Codes promo | Codes d'offre [T10] | Rabais instantanés [P2] | Rabais automatiques et codes [S1] | Oui [B2] | Oui (Run 36) |
| Options, ajouts | Forfaits VIP (aide TM) | Réservation d'hébergement [P5] | Ajouts (Professional) [S2] | Ajouts [B2] | Oui, avec stock par séance (Run 49) |
| Abonnements, forfaits, adhésions | Billets de saison via Account Manager [E1] | Abonnements [P2] | Adhésions, forfaits, saison [S1] | Non vu | Partiel : billet ouvert (Run 37) |
| Contrôle d'accès, scan | SafeTix, code rotatif [T13] | App de validation en temps réel [P2] | Scan par téléphone [S1] | App d'enregistrement [B2] | Oui : hors ligne, Ed25519, multi-portes, compteur (Runs 03, 09, 14, 33) |
| Vente à la porte | Non vu | Guichet [P2] | PDV, Square, débit / NFC [S1][S2] | Paiement sans contact [B2] | Partiel : carte par Stripe, sans argent comptant (Run 35, choix voulu) |
| Rapports | TM1 [T17] | Temps réel [P2] | Temps réel [S1] | Oui [B2] | Oui : TPS / TVQ, par jour, par provenance, CSV (Runs 26, 49) |
| Courriel, SMS | Outils marketing TM1 [T17] | Services promo, infolettres [P2] | Campagnes courriel [S1] | Campagnes, pubs Meta [B2] | Oui, sous la LCAP (Runs 42, 46, 48) |
| Pixels, GA, UTM | Non vu | Pixel Facebook, GA, GTM, Mailchimp [P3] | Pixels, GA, liens de suivi [S1] | Non vu | Partiel : UTM par commande (Run 49) ; pas de pixel |
| Widget, intégration, API | Discovery API, Partner API [T15][T16] | WordPress, panier intégré, Facebook [P3] | Widgets, webhooks, docs [S1] | Paiement intégré, API [B2] | Partiel : `/widget.js` (Run 12), API admin ; pas d'API publique |
| Marque blanche | Pages de marque (`brand=evenko`) [E1] | Oui [P2] | Page à votre image [S1] | Non vu | Partiel : look par Brand, racine en marque blanche (Runs 50, 61) |
| Argent à l'organisateur | Non vu | Son compte marchand ou le leur [P4] | Avances (conditions) [S2] | Versements avant l'événement [B2] | Oui : Stripe Connect, argent direct chez l'organisateur (Run 02) |
| Annulation | Statuts annulé / reporté (aide TM) | Non vu | Non vu | Non vu | Oui : remboursement complet automatique (Run 10) ; avis de changement d'heure ou de lieu non vu |

## Écarts prioritaires

Effort : S = environ 1 run, M = 2 à 4 runs, L = 5 runs et plus. « Back » = Hono + PostgreSQL (+ Stripe). « Front » = HTML serveur + JS simple.

1. **Conformité OPC à la caisse et après.** Afficher la politique d'échange et de remboursement de la Brand avant le paiement, et la mettre dans le courriel. Avertir chaque acheteur quand l'organisateur change la date, l'heure ou le lieu d'une séance.
   Pourquoi : c'est la loi [L2][L4]. Sans ces renseignements, le client peut annuler son achat [L11]. Effort : S. Type : Back (champ par Brand, courriel) + Front. Légal : OPC.
2. **Billets dans Apple Wallet et Google Wallet.** Tous les grands l'offrent (TM, Point de vente, Showpass, Eventbrite).
   Effort : M. Type : Back. Le pass porte le même QR `ALK1`, donc le scan hors ligne ne change pas. Le certificat Apple (programme développeur) va seulement dans le `.env` du serveur. Légal : pass en français d'abord.
3. **Transfert de billet à un ami.** Nouveau QR pour le destinataire, l'ancien est annulé. Le changement de séance fait déjà ce remplacement (Run 37).
   Effort : M. Type : Back (révocation dans le manifeste hors ligne) + Front `/billets`. Légal : Loi 25 (courriel du destinataire : but et durée). Un transfert gratuit n'est pas une revente (à faire confirmer par un juriste).
4. **Données d'événement structurées et pages Salle.** Catégorie et genre choisis dans `/ops` (au lieu de les deviner par mots), âge, langue du spectacle, ouverture des portes, adresse, carte, accessibilité, stationnement, billet accompagnateur CAL.
   Pourquoi : c'est la force d'evenko [E1][E2] et ça rend la recherche de l'accueil fiable. Effort : S–M. Type : Back (colonnes, `/ops`) puis Front. Légal : CAL [L10].
5. **Liste d'attente pour les séances complètes.** Un avis quand une place revient (remboursement, réservation expirée).
   Effort : M. Type : Back. Légal : LCAP (consentement à l'inscription, un seul message), Loi 25 (effacer après la séance).
6. **Suivre un organisateur et recevoir les alertes de mise en vente.** Étape 1 : un bouton qui utilise l'inscription à l'infolettre déjà en place (Run 44). Étape 2 : courriel automatique à chaque nouvel événement.
   Effort : S puis M. Type : Front + route existante, puis Back. Légal : double opt-in déjà conforme.
7. **Préventes et billets à code d'accès.** Type de billet caché, code unique ou partagé, fenêtre de prévente, limite par code.
   Effort : S–M. Type : Back + Front boutique. Légal : prix tout inclus aussi en prévente.
8. **Compte acheteur léger.** Connexion par lien envoyé par courriel, sans mot de passe : toutes mes commandes, favoris et suivis synchronisés.
   Effort : M. Type : Back. Légal : Loi 25, confidentialité par défaut ; export et anonymisation déjà faits (Run 20).
9. **Plan de salle et places assignées.** Il en faut un pour vendre les salles de spectacle et les arénas comme celles d'evenko.
   Effort : L. Type : Back (stock par siège, réservation par siège, sièges accessibles, éditeur) + Front (SVG utilisable au clavier). Un service tiers payant (ex. seats.io) est à évaluer. Légal : prix tout inclus par section.
10. **File d'attente virtuelle pour les grosses mises en vente.** ALKAO ne survend pas (Run 15). La file protège le serveur et garde l'ordre d'arrivée.
    Effort : M. Type : Back (jeton de passage) ou service payant (ex. Cloudflare Waiting Room, à évaluer).
11. **Cartes-cadeaux par Brand.** Effort : M–L. Back + comptabilité (montant dû). Légal : pas de date d'expiration ni de frais d'activation [L5][L6].
12. **Pixels Meta et GA4 / GTM par Brand, avec consentement.** Effort : S–M. Back (réglage) + Front (bandeau). Légal : Loi 25, désactivé par défaut [L9].
13. **Revente entre fans au prix payé** (comme l'Échange au prix coûtant de TM [T5]). Effort : L. Légal : avis « revente », nom du dernier propriétaire, ventilation des frais [L2][L3].
14. **PayPal et paiement en versements** (Klarna ou Affirm par Stripe). Effort : S–M. Le code accepte seulement la carte, car il suppose un paiement confirmé tout de suite (`src/payments/stripe-gateway.ts`). Légal : toujours montrer le total, jamais le seul versement [L1].
15. **Assurance billet par un partenaire.** Effort : M. Légal : vendre de l'assurance au Québec est encadré (AMF, à vérifier).
16. **Passes de saison, adhésions, forfaits de plusieurs événements.** Effort : M–L. Légal : le total du forfait est mis en évidence [L1] ; bouton de résiliation si c'est un abonnement [L2].
17. **Tarifs par paliers (prix hâtifs), puis prix dynamique.** Effort : M, puis L. Légal : pas de faux rabais [L1].
18. **API publique de découverte et flux JSON / iCal** pour médias et partenaires. Effort : S–M. Back.
19. **App native.** Effort : L. Une PWA installable passe avant (voir plus bas).
20. **Code QR rotatif anti-capture d'écran (comme SafeTix).** Effort : L. Il entre en conflit avec le QR dans le courriel et le scan hors ligne. Priorité basse.

Hors liste : l'argent comptant à la porte est écarté exprès (décision 3, `docs/ALKAO_DECISIONS.md`).

## Faisable tout de suite sur la page d'accueil

**Fait au Run 66 :** les points 1 à 6 (sans les recherches récentes : la recherche Ctrl+K montre déjà les favoris et les vus récemment) et le 10 pour l'accueil.
**Fait au Run 67 :** les points 7 (suivre un organisateur), 8 (vue agenda) et 9 (page Accessibilité).
**Fait au Run 69 :** l'écart 4 en partie — données d'événement (catégorie, âge, portes, langue, accessibilité). Reste : les pages Salle.

Front seulement, avec les données que l'accueil reçoit déjà (`HomeEvent` : titre, description, photo, salle, ville, fuseau, séances, `fromCents`, lien boutique, Brand et logo). La PR #76 a déjà la recherche, les tuiles, les cartes « À partir de X $ + taxes », l'aperçu, le partage, les favoris, Ctrl+K, l'assistant FAQ et l'avis de langue.

1. **JSON-LD plus riche** : ajouter `offers` (prix à partir de, `CAD`, `InStock`, lien d'achat) et une entrée par séance. Les moteurs de recherche montrent mieux les événements.
2. **Filtre prix et tri** : « Gratuit », « Moins de 25 $ », tri par date ou par prix (`fromCents`).
3. **Filtre par organisateur** : pastilles avec le logo de chaque Brand.
4. **« Ajouter au calendrier »** dans l'aperçu : fichier `.ics` fait dans le navigateur, comme au Run 31.
5. **Lien « Itinéraire »** vers Google Maps ou Plans avec le nom de la salle et la ville. C'est un simple lien, sans script tiers (bon pour la Loi 25).
6. **Recherches récentes et « Vus récemment »** sur l'appareil, comme evenko, avec un bouton pour effacer.
7. **Bouton « Suivre cet organisateur »** : envoie le courriel à la route publique d'infolettre déjà en place (Run 44, double opt-in). À vérifier : la Brand doit avoir le Ticketing actif.
8. **Vue agenda** : les séances jour par jour.
9. **Page « Accessibilité »** : WCAG 2.1 AA visé, contact, aide pour les gens qui ont une carte CAL (texte seulement).
10. **PWA** : un manifeste pour installer l'accueil et `/billets` sur l'écran du téléphone (le service worker de `/billets` existe déjà, Run 51).

## Prochaines étapes produit

0. Vérifier sans code qu'Apple Pay et Google Pay s'affichent dans Stripe Checkout, sur un vrai iPhone et un vrai Android, avec les moyens de paiement des comptes connectés [X1][X2].
1. Run court « conformité OPC » : écart 1.
2. Données d'événement et pages Salle : écart 4. Ça nourrit l'accueil.
3. Wallet + transfert : écarts 2 et 3. Même zone de code (`/billets`, QR, manifeste).
4. Liste d'attente + suivre un organisateur + prévente : écarts 5, 6 et 7.
5. Compte léger : écart 8.
6. Gros chantiers à cadrer : plan de salle (9) et file virtuelle (10), puis les écarts 11 à 20.

## Sources

Méthode : ticketmaster.ca refuse les robots (403). Les faits Ticketmaster viennent des articles publics de help.ticketmaster.ca, lus par son API publique. Les pages evenko se remplissent en JavaScript : les faits viennent des données de la page, lues le 2026-10-13.

[T1]: https://help.ticketmaster.ca/hc/en-us/articles/9407945563025
[T2]: https://help.ticketmaster.ca/hc/en-us/articles/9411038042257
[T3]: https://help.ticketmaster.ca/hc/en-us/articles/10441030000529
[T4]: https://help.ticketmaster.ca/hc/en-us/articles/9436941095825
[T5]: https://help.ticketmaster.ca/hc/en-us/articles/10436099720721
[T6]: https://help.ticketmaster.ca/hc/en-us/articles/10970462238225
[T7]: https://help.ticketmaster.ca/hc/en-us/articles/10075943518993
[T8]: https://help.ticketmaster.ca/hc/en-us/articles/14915383005457
[T9]: https://help.ticketmaster.ca/hc/en-us/articles/10266458391953
[T10]: https://help.ticketmaster.ca/hc/en-us/articles/10396347601809
[T11]: https://help.ticketmaster.ca/hc/en-us/articles/10435943281041
[T12]: https://help.ticketmaster.ca/hc/en-us/articles/10258994268305
[T13]: https://business.ticketmaster.com/safetix/
[T14]: https://business.ticketmaster.com/soccer/
[T15]: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
[T16]: https://developer.ticketmaster.com/products-and-docs/apis/partner/safetix/
[T17]: https://business.ticketmaster.com/harness-the-power-of-tm1-with-the-latest-updates/
[E1]: https://evenko.ca/fr/evenements
[E2]: https://evenko.ca/fr/evenements/mtelus/buena-vista-social-orchestra?code=e007846
[E3]: https://evenko.ca/fr/faq
[E4]: https://apps.apple.com/us/app/-/id999416213
[P1]: https://lepointdevente.com/
[P2]: https://lepointdevente.com/organisateurs/services
[P3]: https://lepointdevente.com/organisateurs/integrations
[P4]: https://lepointdevente.com/organisateurs/tarifs
[P5]: https://aide.lepointdevente.com/fr/collections/572670-f-a-q-achat-de-billets-en-ligne
[P6]: https://aide.lepointdevente.com/fr/articles/5512591-comment-ajouter-mon-billet-electronique-a-mon-wallet
[P7]: https://aide.lepointdevente.com/fr/articles/5512692-comment-transferer-un-billet-electronique-a-une-autre-personne
[P8]: https://aide.lepointdevente.com/fr/articles/1715600-q-quels-modes-de-paiement-acceptez-vous
[P9]: https://aide.lepointdevente.com/fr/articles/1715770-q-peut-on-m-ajouter-sur-une-liste-d-attente-si-une-place-se-libere
[S0]: https://www.showpass.com/
[S1]: https://www.showpass.com/sell/ticketing-features
[S2]: https://www.showpass.com/sell/pricing
[S3]: https://help.showpass.com/hc/en-us/articles/18150792867479-Ticket-Buyer-Guide-Showpass-Official-Resale
[S4]: https://help.showpass.com/hc/en-us/articles/17968932822039-Ticket-buyer-guide-How-to-join-a-waitlist-for-a-sold-out-event
[S5]: https://help.showpass.com/hc/en-us/articles/360023831873-Ticket-buyer-guide-How-to-transfer-tickets-or-products
[S6]: https://help.showpass.com/hc/en-us/articles/6955702144663-Apple-Wallet-Google-Wallet
[B1]: https://www.eventbrite.ca/
[B2]: https://www.eventbrite.ca/organizer/pricing/
[B3]: https://www.eventbrite.com/help/en-us/articles/431834/how-to-transfer-tickets-to-someone-else/
[B4]: https://www.eventbrite.com/help/en-us/articles/783059/how-to-use-the-eventbrite-app/
[B5]: https://www.eventbrite.com/help/en-us/articles/133701/how-to-set-up-attendee-self-service-registration-event-transfers/
[D1]: https://dice.fm/
[D2]: https://dice.fm/blog/identify-fan-demand-with-the-waiting-list
[K1]: https://www.ticketpro.ca/
[L1]: https://www.opc.gouv.qc.ca/commercant/secteur/billet-spectacle/tout-inclus
[L2]: https://www.opc.gouv.qc.ca/commercant/nouvelles-obligations
[L3]: https://www.opc.gouv.qc.ca/commercant/secteur/billet-spectacle/revente
[L4]: https://www.opc.gouv.qc.ca/commercant/pratique-commerce/contrats-distance/renseignement-avant-contrat
[L5]: https://www.opc.gouv.qc.ca/commercant/secteur/carte-prepayee/carte-argent/date-dexpiration
[L6]: https://www.opc.gouv.qc.ca/commercant/secteur/carte-prepayee/carte/frais
[L7]: https://www.quebec.ca/nouvelles/actualites/details/revente-de-billets-et-abonnements-a-divers-produits-et-services-la-loi-resserree-des-samedi-pour-une-meilleure-protection-des-consommateurs-72420
[L8]: https://www.oqlf.gouv.qc.ca/charte/charte/
[L9]: https://www.cai.gouv.qc.ca/protection-renseignements-personnels/sujets-et-domaines-dinteret/principaux-changements-loi-25
[L10]: https://keroul.qc.ca/en/free-for-accompanying-person.html
[L11]: https://www.opc.gouv.qc.ca/commercant/secteur/billet-spectacle/annulation-remboursement
[X1]: https://docs.stripe.com/payments/wallets
[X2]: https://docs.stripe.com/apple-pay
