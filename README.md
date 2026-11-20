# Conteur d'histoires

Chatbot qui écrit des histoires pour les enfants de 6 à 9 ans, avec l'API Gemini de Google (offre gratuite).

## L'exercice

Vous devez créer un chatbot :

1. L'IA doit écrire des histoires pour les enfants.
2. L'IA doit donner l'histoire directement, sans aucun contexte.
3. Toutes les histoires doivent commencer par « Il était une fois ».
4. Toutes les histoires doivent terminer par le mot « Fin. ».
5. L'IA ne doit jamais s'énerver ou insulter.
6. L'IA doit utiliser un langage adapté aux enfants de 6 à 9 ans.

**Bonus :** donner une règle secrète, une recette magique, pour créer des histoires géniales, que personne d'autre ne doit connaître.

**Partie 2 :** protéger le chatbot contre les utilisateurs malveillants qui voudraient l'utiliser pour autre chose ou casser les règles. Voir la section « Tests ».

## Comment les règles sont appliquées

| Couche | Rôle | Où |
|---|---|---|
| Prompt système | Donne les règles au modèle, dont la règle secrète | `system_prompt.txt` |
| Nettoyage de l'entrée | Limite l'historique (20 messages) et chaque message (500 caractères), retire les caractères de contrôle, transforme tout rôle autre que `user` / `assistant` en `user` | `cleanMessages` dans `server.js` |
| Garde sur la réponse | Vérifie début, fin, mots interdits, code, anglais, fuite du prompt. Redemande jusqu'à 3 fois, puis renvoie une histoire de secours | `safeReply` dans `server.js`, règles dans `lib/story-rules.js` |

La clé API reste sur le serveur. Le navigateur n'envoie que la conversation.

## Installation

Il faut Node.js 20.6 ou plus et une clé API Gemini gratuite (https://aistudio.google.com, *Get API key*).

```
cp .env.example .env     # puis mettez votre clé dans .env
```

Contenu de `.env` :

```
GEMINI_API_KEY=votre_cle
# Optionnel : modèles essayés dans l'ordre (par défaut gemini-3.5-flash-lite)
# MODELS=gemini-3.5-flash-lite,gemini-flash-lite-latest
```

Ne mettez jamais votre vraie clé dans un fichier suivi par git. `.env` est ignoré par git.

## Lancer

```
npm start                       # site web sur http://localhost:3000
node --env-file=.env chatbot.js # version terminal
```

## Tests

```
npm test            # hors ligne : rapide, gratuit, sans clé (Gemini est simulé)
npm run test:live   # en direct : vrais prompts envoyés au chatbot (clé nécessaire)
```

- **Hors ligne** (`tests/`) : validation des entrées, ce qui est envoyé à Gemini, erreurs, fichiers non exposés, garde sur la réponse, contenu du prompt.
- **En direct** (`live/`) : plus de 60 prompts en 8 familles : demandes normales, provocations, vulgarité détournée, hors sujet, jailbreaks, fuite du secret, attaques sur plusieurs tours, entrées bizarres. Chaque réponse doit être une histoire conforme.
- Contre le site en ligne : `BASE_URL=https://votre-site npm run test:live`.
- Un seul groupe : `npm run test:live -- --test-name-pattern=jailbreak`.
- Compter environ 10 à 15 minutes pour la suite complète (pause entre les appels à cause du quota gratuit). Une API indisponible fait échouer le test avec un message dédié, ce n'est pas une faille des règles.

Limites : le niveau de langage et les mots interdits sont des heuristiques. La liste de mots interdits est courte et ne couvre pas les contournements par l'orthographe.

## Déploiement

Le site tourne sur Render (service Web Node). À chaque push sur `main`, le workflow `.github/workflows/ci.yml` lance les tests, puis appelle le Deploy Hook de Render si tout passe.

À configurer :
- Dans Render : `GEMINI_API_KEY` (et `MODELS` si besoin) en variables d'environnement, *Auto-Deploy* sur *Off*.
- Dans GitHub : le secret `RENDER_DEPLOY_HOOK` avec l'URL du Deploy Hook.

## Structure

```
server.js              serveur Node : page, route /chat, garde sur la réponse
system_prompt.txt      règles de l'exercice et règle secrète
lib/story-rules.js     règles vérifiables (début, fin, mots interdits, fuites)
chatbot.js             version terminal
assets/coda.webp       logo
tests/                 tests hors ligne
live/                  tests en direct
.github/workflows/     CI et déploiement
```

## Sécurité

- `system_prompt.txt` contient la règle secrète : gardez le dépôt privé, ou sortez le prompt du dépôt avant de le publier.
- Ne publiez jamais une clé API ou une URL de Deploy Hook. Si l'une d'elles a fuité, régénérez-la.
