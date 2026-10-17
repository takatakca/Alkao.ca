# Havana Resort sur alkao.ca (Run 91)

Pourquoi les événements de Havana ne sont pas sur alkao.ca aujourd'hui :

- alkao.ca répond, mais sa base n'a **aucune Brand inscrite** avec des dates en vente. La page d'accueil affiche donc « Aucun organisateur n'affiche d'événement sur ALKAO pour le moment ».
- Havana Resort n'a **jamais été créé dans ALKAO** en production. Promo Havana n'a ni `ALKAO_CLIENT_ID` ni `ALKAO_BRAND_ID` (voir `docs/COOLIFY_RESOURCE_STATUS.md` dans son dépôt), et l'API publique d'ALKAO renvoie 404 pour ce Client.
- Le service en ligne roule encore une ancienne version (Coolify, issue #84).

Aucune de ces étapes ne peut se faire depuis le code : il faut l'accès au serveur, aux clés et à Stripe. Une fois le Client créé, tout le reste se fait en une commande. Comptez environ 30 minutes.

## 1. Mettre ALKAO à jour (opérateur Coolify)

1. Dans Coolify, ressource ALKAO : `ALKAO_MIGRATE_ON_START=true`.
2. Redéployer la dernière version de `main`.
3. Vérifier : `https://alkao.ca/health/ready` doit répondre `"schema":"current"`.

## 2. Créer Havana dans ALKAO (opérateur, une fois)

1. Copier `provisioning.example.json` en `plan.json` et y mettre les **vrais identifiants TAKATAK** :
   - le Client et la Brand Havana Resort ;
   - l'identifiant Supabase du propriétaire, avec le rôle `owner` ;
   - `"ticketing": { "status": "active" }`.
2. Prévisualiser : `npm run control:apply -- plan.json --dry-run`.
3. Envoyer :
   `ALKAO_URL=https://alkao.ca ALKAO_CONTROL_KEY_ID=… ALKAO_CONTROL_SECRET=… npm run control:apply -- plan.json`
   Les clés sont celles de `ALKAO_CONTROL_KEYS`, sur le serveur seulement ; ne les écrivez jamais dans Git.
4. Sur le serveur ALKAO : `ALKAO_OPERATIONAL_API_ENABLED=true`.

## 3. Brancher Stripe (le propriétaire de Havana)

1. Dans `/ops`, ouvrir **Paiements** et connecter le compte Stripe de Havana.
2. Ajouter `https://www.promohavana.ca` aux sites autorisés après paiement.

## 4. Charger l'événement Halloween (une commande)

Le fichier `catalogs/havana-halloween-2026.json` reprend le catalogue déjà approuvé de Promo Havana :

- « Halloween Havana 2026 », chaque samedi d'octobre, de 14 h à 22 h, au 631, 7e Rang, Maricourt ;
- Adulte 25 $, Enfant (5 ans et plus) 12 $ ;
- la photo du train, la catégorie Famille et l'avis « ce que le billet ne comprend pas ».

La **capacité par soirée** n'est écrite nulle part : c'est à vous de la donner (`--capacity`).

```bash
# 1. Essai : tout est fait puis annulé, rien n'est enregistré.
DATABASE_URL=… npm run events:import -- --client <clientId> --brand <brandId> \
  catalogs/havana-halloween-2026.json --capacity <places par soirée> --dry-run
# 2. Pour vrai : les soirées à venir sont mises en vente et l'événement est affiché sur alkao.ca.
DATABASE_URL=… npm run events:import -- --client <clientId> --brand <brandId> \
  catalogs/havana-halloween-2026.json --capacity <places par soirée> --publish --list-on-alkao
```

Comment l'import se comporte :

- **Les dates passées ne sont jamais créées.** Le 17 octobre après 14 h, seules les soirées du 24 et du 31 sont mises en vente.
- **On peut le relancer sans risque.** La salle, l'événement, les tarifs et les dates qui existent déjà sont gardés tels quels, sans doublon.
- **`--list-on-alkao` est le consentement de la Brand** : c'est le même interrupteur que « Afficher mes événements sur ALKAO » dans **Apparence**.
- **Chaque création est notée dans le Journal** (`source: events:import`).

## 5. Apparence (le propriétaire, 2 minutes)

Dans `/ops`, ouvrir **Apparence** et mettre :

- le logo `https://www.promohavana.ca/brand/havana-resort-logo-blanc.png` ;
- la couleur de Havana ;
- le courriel et le téléphone.

## 6. Vérifier

1. `npm run check:golive -- --url https://alkao.ca --client <clientId> --brand <brandId>` jusqu'à n'avoir plus aucun ✘.
2. Vérifier que `https://alkao.ca/` montre « Halloween Havana 2026 », à partir de 12 $ + taxes.
3. Faire un achat test et vérifier :
   - le courriel avec les billets ;
   - les codes QR sur `/billets` ;
   - un scan à l'entrée.

## 7. Promo Havana vend par ALKAO

Dans Coolify, ressource Promo Havana, mettre :

- `ALKAO_URL` : l'adresse publique d'ALKAO ;
- `ALKAO_CLIENT_ID` et `ALKAO_BRAND_ID` : les mêmes identifiants qu'à l'étape 2.

Puis redéployer. La page `/billets` de promohavana.ca vend alors les mêmes dates, au même prix et avec le même inventaire qu'alkao.ca.
