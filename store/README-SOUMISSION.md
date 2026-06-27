# Soumettre Manga Translator au Chrome Web Store

Marche à suivre, étape par étape.

## 1. Compte développeur (~5 $, une seule fois)
1. Va sur https://chrome.google.com/webstore/devconsole
2. Connecte-toi avec ton compte Google, paie les frais uniques d'inscription
   (~5 $).

## 2. Le paquet à téléverser
Le fichier **`manga-translator-1.0.0.zip`** (généré à la racine du projet par le
script ci-dessous). Il contient UNIQUEMENT les fichiers de l'extension :
`manifest.json`, `background.js`, `sidepanel/`, `lib/`, `icons/*.png`.
Il **n'inclut pas** `webapp/`, `.git`, `CONTEXT.md`, ni le dossier `store/`.

Pour le (re)générer :
```bash
# depuis la racine du projet, dans PowerShell
./store/build-zip.ps1
```

## 3. Créer l'élément dans le dashboard
1. « Add new item » → téléverse le `.zip`.
2. Remplis la fiche avec les textes de **`store/LISTING.md`**.
3. Ajoute **2 à 3 captures d'écran** de l'extension en action (1280×800 ou
   640×400 px). Obligatoire. Astuce : capture le panneau latéral avec des
   bulles traduites.
4. Icône de la boutique : `icons/icon128.png` est déjà au bon format.

## 4. Politique de confidentialité (OBLIGATOIRE)
Le dashboard demande une **URL publique** vers la politique de confidentialité.
Le texte est dans **`store/PRIVACY.md`**. Options pour l'héberger :
- **GitHub** : rends le dépôt public, puis l'URL du fichier (ex.
  `https://github.com/Pierre-finance/manga-translator-extension/blob/main/store/PRIVACY.md`)
  convient.
- Ou colle le texte dans un **Gist public** / une page Notion publique, et
  utilise cette URL.

Dans l'onglet « Privacy practices », justifie les permissions avec la section
correspondante de `store/LISTING.md`, et **coche les usages de données** :
l'extension transmet le contenu capturé aux services de traduction/IA choisis
par l'utilisateur, ne vend aucune donnée.

## 5. Soumettre
« Submit for review ». Délai de validation Google : généralement quelques jours,
parfois jusqu'à 1-2 semaines pour une première soumission avec `<all_urls>`.

## En cas de refus
Le motif le plus fréquent ici sera la permission large (`<all_urls>`) ou la
politique de confidentialité. Réponds en pointant la justification (capture de
l'onglet à la demande, aucune collecte) — c'est un usage légitime pour un outil
de capture/traduction.
