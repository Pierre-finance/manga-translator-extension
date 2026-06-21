# Manga Translator — Contexte projet

## Objectif général

Extension Chrome MV3 qui permet de lire un scan manga en anglais et d'obtenir la
**traduction française de chaque bulle**. But final : la **rendre publique**, donc
sans coût par utilisateur pour le développeur.

### Architecture hybride (deux modes, choisis dans ⚙️ Réglages)

| Mode | Outils | Caractéristiques |
|---|---|---|
| **Gratuit (défaut)** `translationMode='local'` | Tesseract.js (OCR local) + MyMemory (trad) | 100% local/gratuit, aucune clé, **qualité correcte** (plafond sur le lettrage manga) |
| **IA (optionnel)** `translationMode='ai'` | **Multi-fournisseurs BYOK (18)** : Gemini, Groq, Mistral, OpenRouter, Together, SambaNova, GitHub Models, Cohere, **Ollama/LM Studio (local, sans clé)**, Nebius, Novita, DeepInfra, Hyperbolic, Fireworks, OpenAI, xAI, Anthropic | Meilleure détection + traduction ; clé(s) utilisateur (sauf local) ; **bascule auto si quota dépassé** (gratuits + local en tête) |

Pourquoi hybride : Tesseract tourne dans le navigateur (zéro coût/serveur → publiable
gratuitement), mais sa qualité plafonne sur le lettrage BD. Le mode IA (clé fournie
par l'utilisateur) offre la qualité max sans coût pour le dev. `chrome.storage.local`
stocke `translationMode`, `aiKeys` (clé par fournisseur) et `aiEnabled` (fournisseurs
actifs). **18 fournisseurs, bascule** : on essaie les fournisseurs activés dans l'ordre de
`AI_PROVIDERS` (gratuits + locaux d'abord, payants ensuite) et on passe au suivant si
l'un échoue (quota, clé, réseau) → contourne les quotas. **OpenRouter** = routeur (1 clé
→ des centaines de modèles). **Ollama / LM Studio** = serveurs **locaux** (`localhost`,
compatibles OpenAI) → flag `noKey:true` (pas de clé ; `aiChain`/validation/`analyzeOpenAICompatible`
tolèrent l'absence de clé). La liste des réglages se génère depuis `AI_PROVIDERS`
(`buildProviderRows`). Ancienne clé `geminiApiKey` migrée vers `aiKeys.gemini`.

> ⚠️ **Pas la peine d'ajouter Bedrock / Vertex / Azure OpenAI** : auth complexe
> (SigV4/OAuth, endpoint par utilisateur), incompatible avec le BYOK simple. Écarté.

> ⚠️ **MyMemory `&de=` (e-mail)** : `MYMEMORY_EMAIL` dans sidepanel.js pointe
> actuellement vers l'e-mail du dev → **à retirer ou rendre par-utilisateur avant
> publication** (sinon tous les utilisateurs partagent le quota du dev).

L'extension s'ouvre dans un panneau latéral (Side Panel API). Elle n'injecte rien
dans la page. Les deux modes finissent par `renderCards()` (carte 🇬🇧/🇫🇷 par bulle).

---

## Architecture générale

```
[Page web manga]
      │
      ▼
[background.js — service worker MV3]
  • CAPTURE_TAB → chrome.tabs.captureVisibleTab (PNG)
      │
      ▼ message { ok, data: { dataURL } }
      │
[sidepanel/sidepanel.html + sidepanel.js]
  • Sélection de zone (SelectionCanvas)
  • preprocessImageForOCR  → gris + marge + upscale
  • ocrImage (Tesseract)   → mots + bbox
  • recheckLowConfWords    → relecture zoomée des mots douteux
  • groupWordsIntoBubbles  → regroupement spatial en bulles
  • translateWithMyMemory  → FR par bulle
  • renderBubbles          → 1 carte (🇬🇧 OCR + 🇫🇷 MyMemory) par bulle
```

---

## Fichiers clés

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3, permissions, CSP (MyMemory uniquement) |
| `background.js` | Service worker : capture de l'écran visible (`CAPTURE_TAB`) |
| `sidepanel/sidepanel.html` | UI du panneau latéral |
| `sidepanel/sidepanel.js` | Tout le pipeline : capture → preprocess → OCR → regroupement → MyMemory |
| `sidepanel/sidepanel.css` | Styles dark theme |
| `sidepanel/selector.js` | Canvas de sélection de zone |
| `sidepanel/providers.js` | Mode IA : `AI_PROVIDERS` (méta, `kind`+`endpoint`) + `analyzeWithProvider(id,key,model,b64,mime)` → `[{en,fr}]`. Dispatch piloté par `kind` ('gemini' / 'anthropic' / 'openai'). Ajouter un fournisseur compatible OpenAI = 1 entrée + son domaine au CSP. Prompt commun `AI_PROMPT`, parser `parseAiBlocks` |
| `lib/tesseract/` | Tesseract.js v5.1.1 (local) |
| `lib/tesseract/lang/eng.traineddata` | Modèle tessdata_best (~15 MB) |
| `webapp/` | **PWA mobile** (Android/iOS) : réutilise le pipeline + `providers.js` via chemins relatifs ; image importée au lieu de capture d'onglet. `index.html` + `app.js` + `style.css` + `manifest.webmanifest` + `sw.js`. Déploiement GitHub Pages (voir `webapp/README.md`) |

---

## manifest.json — points importants

```json
"content_security_policy": {
  "extension_pages": "… connect-src 'self' https://api.mymemory.translated.net + tous les domaines des fournisseurs IA (generativelanguage.googleapis.com, api.openai.com, api.anthropic.com, api.mistral.ai, api.groq.com, openrouter.ai, api.x.ai, api.together.xyz, api.fireworks.ai, api.deepinfra.com, api.sambanova.ai, api.hyperbolic.xyz)"
}
```

- `'wasm-unsafe-eval'` : requis pour Tesseract.js (WASM)
- `connect-src` : MyMemory (local) + tous les fournisseurs IA (Gemini/OpenAI/Anthropic/Mistral/Groq). **MV3 + `host_permissions: <all_urls>` ⇒ pas de blocage CORS** ; il faut juste lister chaque domaine ici.
- `storage` : stocke `translationMode`, `aiKeys`, `aiEnabled`.

---

## background.js — points importants

- Pattern IIFE `(async()=>{...})(); return true;` sur le handler de message
- Un seul message : `CAPTURE_TAB` → `chrome.tabs.captureVisibleTab` (PNG)
- Réponse toujours `{ ok, data?, error? }` ; message clair si page système/protégée
- **Capture pleine page retirée (juin 2026)** : trop lente, peu utile (scroll long).
  Plus de `chrome.scripting` → permission `scripting` retirée du manifest.

---

## Pipeline OCR → traduction (le cœur, dans sidepanel.js)

Une seule entrée : **Écran visible** (`runVisibleCapture` → sélecteur de zone →
`runAnalysis`). Deux choix dans le sélecteur : **Analyser la sélection** (1 zone
manuelle) ou **Toute l'image** (détection + zoom auto par zone). Aboutit à
`regionsToBubbles()` puis `renderBubbles()`. (La capture pleine page a été retirée.)

> **Écran visible « Analyser tout » — zoom auto par zone (juin 2026)** :
> `ocrZonesZoomed` fait 2 passes. **Passe 1** = localisation (OCR de l'image
> entière, `recheck:false`) → bulles + bbox. **Passe 2** = pour chaque zone, on
> recadre l'image **source** (`cropImageRect`, aligné sur le texte → jamais coupé)
> et on l'agrandit fort (`preprocessImageForOCR(url, up)` avec `up` adaptatif :
> petite zone = gros zoom, plafond `ZONE_MAX_UP=10`, cible `ZONE_TARGET=1400`),
> puis relecture. = équivalent automatique d'une sélection de zone manuelle, sur
> toutes les bulles. La **sélection manuelle** (« Analyser la sélection ») = 1 passe
> `ocrImage` avec le **même zoom adaptatif** (`up` calculé sur la taille de la
> sélection) **+ relecture par mot** (`recheck` activé) → le mode le plus précis.
> `preprocessImageForOCR(dataURL, upscale=OCR_UPSCALE)` accepte un facteur ;
> `ocrWords(url, {recheck})` partage extract+filtre.
>
> **Anti-bruit interface** : `isUiNoise` + `UI_STOPWORDS` dans `regionsToBubbles`
> jette une bulle dont **tous** les tokens sont des mots d'interface (chapter,
> webtoon, next, menu…) → règle le bruit « Cap 8/9/10 » (sélecteur de chapitres).
>
> ⚠️ **Pistes écartées après test** : *zoom de la page en direct avant capture*
> (`chrome.tabs.setZoom` — intrusif : le user veut le zoom SUR L'IMAGE après
> capture) et *OCR tuilé en grille aveugle* (coupe les bulles, polarité par tuile
> incohérente → confiance en baisse + lent). Le zoom par zone ci-dessus remplace.

### 1. Prétraitement — `preprocessImageForOCR`

- Upscale **×4** (`OCR_UPSCALE`)
- **Niveaux de gris** Rec.601 — **PAS de binarisation Otsu** : le LSTM de Tesseract
  lit mieux du gris (l'anti-aliasing l'aide) que du noir & blanc dur
- Marge blanche **24 px** (`OCR_MARGIN`) autour (Tesseract aime les bords clairs)
- Polarité : `preprocessImageForOCR(url, upscale, forceInvert)`. `forceInvert=null`
  → auto (inverse si moyenne < 128) ; `true`/`false` → polarité imposée (utilisé par
  l'OCR double-polarité).
- Export PNG lossless.

> **OCR double-polarité (recall, juin 2026)** — `ocrWordsRobust` / `ocrImageRobust` :
> certaines bulles ne ressortaient **pas du tout** quand la polarité globale était
> mauvaise (page sombre + bulle claire, ou inverse → texte « blanc sur noir » →
> Tesseract ne lit rien). On prétraite donc l'image **dans les deux sens**, on OCR
> chaque version, et on **fusionne par position** (`mergeWordsByPosition`, même repère
> car même upscale/marge → bbox comparables ; garde la meilleure confiance). Utilisé
> par les **3 chemins** : sélection manuelle, « Toute l'image » (passes 1 ET 2), et
> « Affiner ». Coût : 2× passes OCR (acceptable, gros gain de recall).

### 2. OCR — `ocrImage`

```javascript
Tesseract.createWorker('eng', 1, {
  workerPath, corePath, langPath,
  workerBlobURL: false,   // CRITIQUE MV3 — pas de blob: URL (origine null)
  gzip: false,            // tessdata_best non compressé
})
// setParameters({ tessedit_pageseg_mode: OCR_PSM })  où OCR_PSM = '11'
//   PSM 11 = "sparse text" : recall maximal (ne rate pas de bulle).
//   On NE se fie PAS au découpage en blocs de Tesseract (peu fiable sur des bulles).
```

Étapes dans `ocrImage` :
1. `extractAllWords(data)` : aplatit tous les mots (`blocks→paragraphs→lines→words`)
   avec leur **bbox** et confiance. En v5, `data.words` racine n'existe plus.
2. `recheckLowConfWords(words)` : voir §3.
3. Filtre **plancher** : on jette les mots dont la confiance est encore
   `< OCR_MIN_CONF` (45) — c'est le bruit (un vrai mot relu en gros remonte au-dessus).
4. `groupWordsIntoBubbles(words)` : voir §4.

Logs console : `[MT] OCR brut :` (avant filtre) et `[MT] OCR gardé :` (après).

### 3. Relecture zoomée — `recheckLowConfWords`

Pour chaque mot de confiance dans **[25, 75)** (`OCR_RECHECK_MIN`/`OCR_RECHECK_CONF`),
plafonné à `OCR_RECHECK_MAX` (20) :
- recadrage sur la **bbox** (+ `OCR_RECHECK_PAD`), zoom **×3** (`OCR_RECHECK_ZOOM`)
- re-OCR en **PSM 8 (mot unique)**, on remplace si la nouvelle confiance est meilleure

Idée clé : **un vrai mot relu en gros devient sûr ; le bruit reste bas.** Donc on ne
supprime jamais un vrai mot (ex. « equipment » jadis perdu), on corrige ou on garde.
Le worker bascule en PSM 8 puis **restaure `OCR_PSM`** dans un `finally`.

### 4. Regroupement en bulles — `groupWordsIntoBubbles`

On ignore les « blocs » de Tesseract et on regroupe NOUS-MÊMES par position :
1. **lignes** : mots dont le centre vertical tombe dans la même bande
2. **bulles** : lignes consécutives séparées par un blanc vertical
   `> BUBBLE_GAP_FACTOR (1.3) × hauteur médiane d'un mot`
3. texte en ordre de lecture (lignes top→bottom, mots left→right) + confiance moyenne

⚠️ Limite : regroupement par blancs **verticaux** → deux bulles **côte à côte** sur la
même bande horizontale peuvent fusionner (à améliorer si besoin).

### 5. Filtres texte (`regionsToBubbles`)

- `wordsToText` : concatène les mots (aucune suppression par confiance ici)
- `filterLexical` : garde un token s'il contient une lettre **ET aucun chiffre**
  (tue « 7Si », « 2} » = bruit OCR)
- `cleanOcrText` : `\n`→espace, espaces multiples→1, trim
- une bulle est gardée si ≥ `OCR_MIN_BUBBLE_LETTERS` (3) lettres (écarte « II », « Me »)
- `isUiNoise` : jette une bulle 100 % mots d'interface (cf. anti-bruit)
- `isLowConfNoise` : jette une bulle **courte ET peu sûre** (`< NOISE_CONF` 50 % et
  ≤ `NOISE_MAX_LETTERS` 3 lettres) → tue les onomatopées mal lues (ex. 척! → « row » 49 %)
- chaque bulle conserve sa `bbox` **source** (repère capture) → sert au bouton « Affiner »

### 6. Traduction — `translateWithMyMemory`

```
GET https://api.mymemory.translated.net/get?q=<texte>&langpair=en|fr
→ responseData.translatedText
```
Une requête **par bulle**, en parallèle. La carte affiche `⏳…` puis le résultat.

### Affichage — `renderCards` / `createBlockCard`

Une carte `.block-card` par bulle, **FR (traduction) mise en avant**, EN (source)
discret en dessous :
```
①                         87%   ← badge n° + pastille de confiance colorée
                                  (conf-high vert / conf-mid orange / conf-low rouge)
🇫🇷  traduction FR              ⧉  ← gras, couleur principale
🇬🇧  texte OCR (source)         ⧉  ← petit, gris
```
Boutons « copier » = icône ⧉ qui apparaît au survol de la carte ; animation
d'entrée `cardIn`. `confClass(c)` choisit la couleur de pastille. `currentBlocks =
[{ en, fr, confidence, bbox }]` ; `fr` rempli au fil des réponses MyMemory
(`block-pending` « Traduction… » en attendant). Garde anti-race via `_ocrGeneration`.

**Bouton « 🔍 Affiner » (faible confiance)** : une carte dont `confidence < LOW_CONF`
(70) prend la classe `.low-conf` (liseré rouge) et affiche « Affiner ». `refineBubble(i)` :
si la `bbox` source est connue (mode « Toute l'image ») → re-recadre cette zone sur
`capturedDataURL`, zoom adaptatif (jusqu'à `ZONE_MAX_UP`), `ocrImage` (avec recheck),
puis met à jour **uniquement cette carte** (texte EN, pastille, traduction). Sinon
(sélection manuelle / mode IA sans bbox) → retour au sélecteur `showSelectState`.
Idée : zoom auto quand la confiance est bonne, re-lecture ciblée sinon (UX publique).

> **Blocs de debug retirés (juin 2026)** : l'aperçu 🔬 image prétraitée et le bloc
> 🐛 « OCR brut → gardé » ne sont plus affichés (rendu plus propre). Le diagnostic
> reste dans la **console** (`[MT] OCR brut/gardé`, `lastOcrDebug`).

---

## Constantes de réglage (haut de sidepanel.js)

| Constante | Déf. | Effet |
|---|---|---|
| `OCR_UPSCALE` | 4 | agrandissement avant OCR |
| `OCR_MARGIN` | 24 | marge blanche autour |
| `OCR_PSM` | '11' | mode segmentation Tesseract (11 = sparse, recall max) |
| `OCR_RECHECK_CONF` | 75 | on relit sous ce seuil… |
| `OCR_RECHECK_MIN` | 25 | …et au-dessus (sous 25 = bruit, pas relu) |
| `OCR_RECHECK_ZOOM` | 3 | zoom sur le mot relu |
| `OCR_RECHECK_MAX` | 20 | plafond de relectures (latence) |
| `OCR_MIN_CONF` | 45 | plancher anti-bruit après relecture |
| `OCR_MIN_BUBBLE_LETTERS` | 3 | taille mini d'une bulle |
| `BUBBLE_GAP_FACTOR` | 1.3 | seuil de séparation des bulles (blanc vertical) |

---

## État actuel (juin 2026)

| Fonctionnalité | État |
|---|---|
| Capture écran visible | ✅ |
| Capture pleine page | ❌ retirée (juin 2026 — trop lente) |
| Zoom auto par zone (« Toute l'image ») | ✅ |
| Prétraitement (gris + marge + ×4, upscale paramétrable) | ✅ |
| OCR Tesseract local (PSM 11) | ✅ |
| Relecture zoomée des mots douteux | ✅ |
| Regroupement spatial en bulles | ✅ |
| Filtres bruit (chiffres, plancher conf, taille mini) | ✅ |
| Traduction MyMemory par bulle | ✅ |
| Mode IA multi-fournisseurs BYOK (Gemini/OpenAI/Claude/Mistral/Groq) + bascule quota | ✅ |
| Sélecteur de mode dans ⚙️ Réglages | ✅ |

### Ce qui reste à améliorer

- **Recall** : certaines bulles peu contrastées restent ratées (ex. « I GOT ROGUE »)
  → diagnostiquer via le log `[MT] OCR brut :` (lu ou pas par Tesseract ?)
- **Bulles côte à côte** : ajouter un découpage horizontal dans `groupWordsIntoBubbles`
- **Qualité traduction** : MyMemory traduit parfois mal (« fighter » → « chasse »).
  Option : passer un e-mail MyMemory (`&de=`) pour augmenter le quota / qualité.
- **Bruit résiduel** : tokens type « hss » (onomatopées) — envisager un dictionnaire.

---

## Pièges techniques à ne pas oublier

| Problème | Solution appliquée |
|---|---|
| Modifs invisibles dans l'extension | Chrome ne hot-reload pas : `chrome://extensions` → 🔄 + rouvrir le side panel |
| Port message fermé avant réponse async | Pattern IIFE + `return true` dans `onMessage` |
| `fetch(dataUrl)` bloqué dans SW MV3 | `dataUrlToBlob()` via `atob` + `Uint8Array` + `new Blob()` |
| Canvas > 16384 px → crash | Scale calculé avant, chunks 12000 px max |
| WASM sans `wasm-unsafe-eval` → bloqué CSP | Ajouté dans `script-src` |
| Worker Tesseract avec blob: URL → origine null | `workerBlobURL: false` |
| `data.words` vide en Tesseract.js v5 | Parcourir `data.blocks[]…words[]` (`extractAllWords`) |
| Découpage en bulles de Tesseract peu fiable | Regroupement spatial maison (`groupWordsIntoBubbles`) |
| Binarisation Otsu → confiance LSTM en baisse | Niveaux de gris, pas de binarisation |
| Mot réel jeté (« equipment ») | Relecture zoomée + plancher APRÈS relecture, jamais avant |
| Bruit OCR pris pour du texte | Filtre chiffres + plancher conf 45 + taille mini bulle |
| Résultats périmés si analyse relancée | Compteur `_ocrGeneration` |
