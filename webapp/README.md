# Manga Translator — version web (PWA)

Appli web installable (Android **et** iOS) qui réutilise le pipeline de l'extension :
OCR local **Tesseract** + zoom par zone + double-polarité + **MyMemory**, ou les
**fournisseurs IA** (`../sidepanel/providers.js`) en BYOK avec bascule.

Au lieu de capturer l'onglet (impossible sur mobile), l'utilisateur **importe une
image** (capture d'écran) ou **prend une photo**.

## Fichiers
- `index.html` — UI
- `app.js` — pipeline porté + glue web (stockage `localStorage`)
- `style.css` — thème sombre, mobile-first
- `manifest.webmanifest` + `sw.js` — installable + cache hors-ligne de la coquille
- réutilise `../lib/tesseract/*` et `../sidepanel/providers.js` (chemins relatifs)

## Tester en local (sur PC)
Il faut un serveur HTTP (le `file://` ne marche pas : service worker + Tesseract).
Depuis la **racine du repo** :
```
python -m http.server 8000
```
Puis ouvre `http://localhost:8000/webapp/`.

## Déployer sur GitHub Pages (HTTPS gratuit → installable sur mobile)
1. Pousse le repo sur GitHub (le dossier `webapp/`, `lib/`, `sidepanel/` doivent y être).
   > ⚠️ Le repo doit être **public** (ou compte GitHub Pro) pour Pages gratuit.
2. GitHub → **Settings → Pages** → *Build and deployment* → Source : **Deploy from a branch**
   → Branch : `main` / dossier `/ (root)` → **Save**.
3. Attends ~1 min. L'appli sera à :
   `https://<ton-user>.github.io/<nom-repo>/webapp/`
4. Sur le téléphone, ouvre cette URL :
   - **Android (Chrome)** : menu ⋮ → *Ajouter à l'écran d'accueil*.
   - **iOS (Safari)** : Partager → *Sur l'écran d'accueil*.

## Limites connues (mobile web)
- **CORS** : certains fournisseurs IA autorisent l'appel depuis un navigateur
  (Anthropic via en-tête dédié, OpenAI, Gemini, OpenRouter…), d'autres peuvent
  **bloquer**. Le mode **local (Tesseract + MyMemory)** marche toujours ; pour l'IA,
  la bascule passe au fournisseur suivant si l'un est bloqué.
- **Fournisseurs locaux** (Ollama / LM Studio) : **masqués** ici — un téléphone ne
  peut pas joindre le `localhost` d'un PC, et HTTPS bloque le HTTP local.
- **1ʳᵉ analyse locale plus lente** : Tesseract télécharge le modèle (~15 Mo) au
  premier usage, puis c'est mis en cache (le service worker le garde hors-ligne).
- **`MYMEMORY_EMAIL`** dans `app.js` pointe vers l'e-mail du dev → à rendre
  par-utilisateur avant une diffusion large (sinon quota partagé).
- **Icônes** : on réutilise `icon128.png` pour toutes les tailles ; pour un rendu
  install parfait, ajouter une icône 512×512 dédiée.
