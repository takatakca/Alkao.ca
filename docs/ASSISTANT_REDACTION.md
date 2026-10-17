# Assistant de rédaction dans /ops (Run 92)

L'assistant rédige des **brouillons** à partir du catalogue de la marque : ses événements, dates, lieux et tarifs. Il en fait deux :

- **Campagnes** : l'objet, l'aperçu, le titre, le texte et le bouton d'un courriel, ou le texte d'un texto. Le personnel donne le but en une phrase, par exemple « rappeler aux familles qu'il reste deux samedis ».
- **Événements** : la description affichée dans la billetterie et sur alkao.ca, à partir de la fiche de l'événement et de quelques notes.

Le brouillon s'insère dans le formulaire. Le personnel le relit et le corrige, puis l'enregistre. L'assistant n'envoie, n'enregistre et ne publie rien lui-même.

## Ce que l'assistant ne peut pas faire

Les règles sont données au modèle, puis **vérifiées dans le code** sur chaque réponse. Un brouillon est refusé s'il contient :

- un prix qui n'est pas dans les tarifs ;
- un rabais, un pourcentage ou un code promo absents de la consigne ;
- « gratuit » alors qu'aucun tarif n'est gratuit ;
- un lien ou une adresse web (le bouton porte déjà le lien de la billetterie) ;
- un champ variable autre que `{prénom}` ;
- un texte trop long (texto : 200 caractères avant la signature et l'arrêt).

Après un refus, l'assistant fait **un seul nouvel essai** en connaissant les raisons du refus. Si le nouveau brouillon est encore refusé, le personnel voit la liste des raisons et rédige lui-même.

L'urgence n'est permise que si elle est vraie. « Il reste peu de places » ne peut être écrit que pour une date où il reste au plus 10 % des places (ou 5 places). « Complet » ne peut être écrit que pour une date vraiment complète.

## Données envoyées

Seul le **catalogue** est envoyé à Anthropic : le nom de la marque, les titres, les dates, les lieux, les prix, l'âge, la langue et l'accessibilité. **Aucun renseignement sur les acheteurs ou les clients** n'est envoyé : ni nom, ni courriel, ni commande. Cela respecte la Loi 25.

La consigne tapée par le personnel est envoyée telle quelle. L'écran rappelle de ne pas y mettre de renseignement personnel.

Le Journal note chaque brouillon : la date, la personne, le type, le résultat et le nombre de jetons. Le texte lui-même n'y est pas gardé.

## Coût

L'assistant utilise l'API Claude d'Anthropic. Elle est **payante à l'usage, sur le compte Anthropic du propriétaire**. Les prix ci-dessous datent d'octobre 2026, en dollars américains.

| Modèle (`ALKAO_ASSISTANT_MODEL`) | Prix par million de jetons (entrée / sortie) | Un brouillon (environ) |
| --- | --- | --- |
| `claude-opus-5-5` (par défaut, le plus soigné) | 4 $ / 20 $ US | 0,03 $ US (environ 0,04 $ CA) |
| `claude-sonnet-5-5` | 2 $ / 10 $ US | 0,015 $ US |
| `claude-haiku-5-5` (le moins cher) | 0,10 $ / 0,50 $ US | moins de 0,001 $ US |

Comment le prix d'un brouillon est estimé :

- environ 3 000 jetons en entrée (les règles et le catalogue) ;
- environ 800 jetons en sortie ;
- un brouillon refusé puis refait coûte le double.

`ALKAO_ASSISTANT_DAILY_LIMIT` (30 par défaut) **plafonne le nombre de brouillons par marque et par 24 heures**. Avec Opus, une marque ne peut donc pas dépasser environ 2 $ US par jour. À 50 brouillons par mois, la facture est d'environ 1,50 $ US par mois.

## Activer (le propriétaire seulement)

1. Créer une clé API sur [console.anthropic.com](https://console.anthropic.com), dans le compte qui paie. Vous pouvez y fixer un plafond de dépense mensuel.
2. Sur le serveur ALKAO (Coolify, variables d'environnement), mettre :
   - `ALKAO_ASSISTANT_ENABLED=true` ;
   - `ANTHROPIC_API_KEY=` suivie de la clé. **Tapez-la vous-même.** Ne la collez jamais dans Git, dans un document ou dans un clavardage : ce dépôt est public.
   - au besoin, `ALKAO_ASSISTANT_MODEL` et `ALKAO_ASSISTANT_DAILY_LIMIT`.
3. Redéployer. La ligne de démarrage du serveur indique `writing assistant on (claude-opus-5-5)`.
4. Dans `/ops`, les boutons apparaissent à deux endroits :
   - **Campagnes → Nouvelle campagne → Rédiger avec l'assistant** ;
   - **Événement → Fiche → Rédiger avec l'assistant**.

Pour couper l'assistant, mettez `ALKAO_ASSISTANT_ENABLED=false` ou retirez la clé, puis redéployez. Les boutons disparaissent. Si la clé a été exposée, révoquez-la dans la console Anthropic.

## Côté technique

- `src/ai/writer.ts` : l'appel à Claude.
  - Il passe par le SDK officiel `@anthropic-ai/sdk`, à une version fixée.
  - La réponse doit suivre un format JSON imposé (zod).
  - L'effort est réglé à `low`.
  - L'option `fallbacks: "default"` est activée : si le modèle refuse, l'API refait la demande sur le modèle de repli choisi par Anthropic.
- `src/ai/drafts.ts` : le catalogue envoyé, les règles et les vérifications.
- Routes :
  - `POST /v1/admin/clients/:c/brands/:b/assistant/campaign`, avec la permission `ticketing.campaigns.manage` ;
  - `POST …/events/:id/assistant/description`, avec la permission `ticketing.catalog.write`.
- Tests :
  - `test/ai/assistant.test.ts` et `test/ui/assistant-ui.test.ts` ;
  - un faux modèle (`test/helpers/writer.ts`) remplace Claude : les tests n'appellent jamais le réseau et ne coûtent rien.
