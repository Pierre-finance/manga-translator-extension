# Fiche Chrome Web Store — Manga Translator

Textes prêts à coller dans le formulaire du Developer Dashboard.

---

## Nom
Manga Translator

## Description courte (132 caractères max)
Traduisez en français les scans manga directement depuis votre onglet : OCR local gratuit, ou IA (votre clé) pour plus de qualité.

## Catégorie
Outils (ou « Productivité »)

## Langue
Français

---

## Description longue

**Lisez vos scans manga en français sans quitter votre onglet.**

Manga Translator ajoute un panneau latéral à Chrome : capturez la page que vous
lisez, et l'extension détecte les bulles, lit le texte et le traduit en
français — anglais, japonais, coréen, et plus.

**Deux modes, vous choisissez :**

🆓 **Mode gratuit (par défaut)**
- Reconnaissance de texte **100 % sur votre appareil** (moteur Tesseract).
- Traduction via MyMemory.
- Aucune clé, aucun compte, aucun coût.

🤖 **Mode IA (optionnel, votre clé)**
- Meilleure détection et traduction, idéal pour le lettrage difficile.
- Compatible avec de nombreux fournisseurs (Google Gemini, OpenAI, Anthropic,
  Mistral, Groq, OpenRouter…) — vous utilisez **votre propre clé**.
- Bascule automatique d'un fournisseur à l'autre si l'un atteint son quota.
- Possibilité d'utiliser un modèle **local** (Ollama / LM Studio), 100 % privé.

**Comment ça marche :**
1. Ouvrez le panneau latéral sur la page de votre manga.
2. Cliquez pour capturer l'écran visible (ou sélectionnez une zone précise).
3. Lisez les traductions, bulle par bulle, avec le texte original en regard.

**Respect de votre vie privée :** rien n'est capturé tant que vous ne le
demandez pas. L'auteur ne collecte aucune donnée ; vos réglages et clés restent
sur votre appareil. Voir la politique de confidentialité.

---

## URL politique de confidentialité
(À héberger publiquement — voir store/README-SOUMISSION.md)

## Justification des permissions (champ « Privacy practices » du dashboard)

- **`<all_urls>` / hôtes** : l'extension doit pouvoir capturer l'onglet visible
  quel que soit le site de lecture, et appeler les API de traduction. La capture
  n'a lieu qu'à la demande explicite de l'utilisateur.
- **`activeTab`** : capturer la page active au moment où l'utilisateur lance
  l'analyse.
- **`storage`** : mémoriser localement les réglages et les clés saisies par
  l'utilisateur.
- **`sidePanel`** : afficher l'interface dans le panneau latéral.
- **Usage des données** : aucune donnée n'est vendue ni transmise à des tiers
  hors des API de traduction/IA choisies par l'utilisateur pour réaliser
  l'analyse demandée.
