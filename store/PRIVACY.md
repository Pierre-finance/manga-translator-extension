# Politique de confidentialité — Manga Translator

_Dernière mise à jour : 27 juin 2026_

Manga Translator est une extension Chrome qui réalise de la reconnaissance de
texte (OCR) et de la traduction en français à partir d'une capture de l'onglet
actuellement affiché. Cette politique explique quelles données sont traitées et
comment.

## Données traitées

L'extension ne traite des données **que lorsque vous lancez vous-même une
analyse** (bouton de capture). Elle traite alors :

- **L'image de l'onglet visible** (capture d'écran de la zone affichée), pour en
  extraire le texte.
- **Le texte extrait**, pour le traduire en français.
- **Vos réglages** (mode de traduction, clés d'API que vous saisissez, e-mail
  MyMemory facultatif), stockés **localement** sur votre appareil via
  `chrome.storage.local`.

L'extension **ne collecte pas** votre historique de navigation, votre identité,
ni aucune donnée à votre insu. Aucune capture n'est faite tant que vous ne
cliquez pas sur le bouton d'analyse.

## Aucune collecte par l'auteur

L'auteur de l'extension **ne reçoit, ne stocke et ne revend aucune donnée**.
L'extension ne possède pas de serveur. Vos réglages et vos clés restent sur
votre machine.

## Services tiers (selon le mode choisi)

Pour fonctionner, l'extension envoie le texte (et, en mode IA, l'image) à des
services tiers que **vous choisissez** :

- **Mode gratuit (par défaut)** : le texte reconnu est envoyé à l'API de
  traduction **MyMemory** (`api.mymemory.translated.net`). La reconnaissance de
  texte (Tesseract) s'exécute, elle, **entièrement sur votre appareil**.
- **Mode IA (optionnel)** : si vous l'activez et fournissez votre propre clé,
  l'image et le texte sont envoyés au(x) fournisseur(s) d'IA que vous avez activé
  (par ex. Google Gemini, OpenAI, Anthropic, Mistral, Groq, etc.), ou à un
  modèle **local** (Ollama / LM Studio) qui ne quitte pas votre machine.

Chacun de ces services applique sa propre politique de confidentialité, que nous
vous invitons à consulter. L'extension ne transmet à ces services **que** le
contenu nécessaire à l'analyse que vous avez demandée.

## Permissions et leur justification

- **`activeTab` / accès à toutes les pages (`<all_urls>`)** : nécessaire pour
  capturer l'image de l'onglet que vous regardez (l'extension ne sait pas à
  l'avance sur quel site vous lirez un manga) et pour communiquer avec les API
  de traduction sans blocage réseau. Aucune page n'est lue automatiquement : la
  capture n'a lieu qu'à votre demande.
- **`storage`** : pour mémoriser vos réglages localement.
- **`sidePanel`** : pour afficher l'interface dans le panneau latéral.

## Contact

Pour toute question : pierredureux59@gmail.com
