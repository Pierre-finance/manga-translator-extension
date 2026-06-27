// ── Prétraitement image pour OCR ───────────────────────────────────────────────
// Upscale ×4 → niveaux de gris (PAS de binarisation Otsu : le LSTM de Tesseract
// préfère le gris à du N&B dur, l'anti-aliasing l'aide) → polarité → marge blanche.
const OCR_UPSCALE = 4;
const OCR_MARGIN  = 24;   // marge blanche autour du texte (px, sur l'image agrandie)

// forceInvert : null = auto (selon la luminosité moyenne) ; true/false = polarité imposée
// (utilisé par l'OCR double-polarité qui essaie les deux sens).
function preprocessImageForOCR(dataURL, upscale = OCR_UPSCALE, forceInvert = null) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width  * upscale;
      const h = img.height * upscale;
      const c = document.createElement('canvas');
      c.width  = w + OCR_MARGIN * 2;
      c.height = h + OCR_MARGIN * 2;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Fond blanc (marge propre — Tesseract aime les bords clairs)
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, OCR_MARGIN, OCR_MARGIN, w, h);

      // On ne traite QUE la zone image (hors marge) pour les stats et le gris.
      const area = ctx.getImageData(OCR_MARGIN, OCR_MARGIN, w, h);
      const d = area.data;
      const n = w * h;

      // Niveaux de gris (Rec.601) + moyenne pour la polarité.
      const gray = new Uint8Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const g = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
        gray[i] = g;
        sum += g;
      }

      // Polarité : Tesseract veut texte foncé sur fond clair.
      // Si l'image est globalement sombre (fond noir, texte blanc) → inverser.
      const invert = forceInvert === null ? (sum / n) < 128 : forceInvert;
      for (let i = 0; i < n; i++) {
        const v = invert ? 255 - gray[i] : gray[i];
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
        d[i * 4 + 3] = 255;
      }

      ctx.putImageData(area, OCR_MARGIN, OCR_MARGIN);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// ── OCR Tesseract (debug local) ───────────────────────────────────────────────
let _tesseractWorker = null;

// PSM 11 = "sparse text" : trouve un maximum de texte, sans hypothèse de mise en
// page. Meilleur recall (ne rate pas de bulle) que PSM 3 dont l'analyse de layout
// ignorait des zones. On regroupe NOUS-MÊMES les mots en bulles (groupWordsIntoBubbles)
// au lieu de faire confiance aux "blocs" de Tesseract, peu fiables sur des bulles.
const OCR_PSM = '11';

async function getOcrWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  _tesseractWorker = await Tesseract.createWorker('eng', 1, {
    workerPath:    chrome.runtime.getURL('lib/tesseract/worker.min.js'),
    corePath:      chrome.runtime.getURL('lib/tesseract/'),
    langPath:      chrome.runtime.getURL('lib/tesseract/lang/'),
    workerBlobURL: false,
    gzip:          false,
    logger: m => {
      if (m.status === 'recognizing text')
        console.log(`[Tesseract] ${Math.round(m.progress * 100)}%`);
    },
  });
  await _tesseractWorker.setParameters({ tessedit_pageseg_mode: OCR_PSM });
  return _tesseractWorker;
}

// Aplati TOUS les mots détectés (toutes hiérarchies confondues) avec leur bbox.
// On ignore volontairement le découpage en blocs de Tesseract (peu fiable sur des
// bulles) : on regroupera nous-mêmes via groupWordsIntoBubbles.
function extractAllWords(data) {
  const words = [];
  for (const b of (data.blocks || []))
    for (const p of (b.paragraphs || []))
      for (const l of (p.lines || []))
        for (const w of (l.words || []))
          if (w.bbox && w.text) words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox });
  // Fallback format plat (v4) si aucun bloc.
  if (!words.length && data.words)
    for (const w of data.words)
      if (w.bbox && w.text) words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox });
  return words;
}

// Regroupe les mots en bulles d'après leur position (bbox).
//  1. lignes : mots dont le centre vertical tombe dans la même bande.
//  2. bulles : lignes consécutives séparées par un blanc vertical > seuil.
// Seuil = facteur × hauteur médiane d'un mot → s'adapte à la taille du texte.
const BUBBLE_GAP_FACTOR = 1.3;

function groupWordsIntoBubbles(words) {
  if (!words.length) return [];

  const heights = words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 1;
  const gapThreshold = medianH * BUBBLE_GAP_FACTOR;

  // 1. Lignes
  const lines = [];
  for (const w of [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    let line = lines.find(L => cy >= L.y0 && cy <= L.y1);
    if (!line) { line = { y0: w.bbox.y0, y1: w.bbox.y1, words: [] }; lines.push(line); }
    line.words.push(w);
    line.y0 = Math.min(line.y0, w.bbox.y0);
    line.y1 = Math.max(line.y1, w.bbox.y1);
  }
  lines.sort((a, b) => a.y0 - b.y0);

  // 2. Bulles (regroupement par blanc vertical)
  const bubbles = [];
  let cur = null;
  for (const line of lines) {
    if (cur && (line.y0 - cur.y1) > gapThreshold) cur = null;
    if (!cur) { cur = { y1: line.y1, lines: [] }; bubbles.push(cur); }
    cur.lines.push(line);
    cur.y1 = Math.max(cur.y1, line.y1);
  }

  // 3. Texte en ordre de lecture + confiance moyenne par bulle
  return bubbles.map(bub => {
    const ws = [];
    for (const line of bub.lines) {
      line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      ws.push(...line.words);
    }
    const conf = Math.round(ws.reduce((s, w) => s + w.confidence, 0) / ws.length);
    return { confidence: conf, words: ws };
  });
}

// ── Relecture zoomée des mots peu sûrs ─────────────────────────────────────────
// Un mot sous OCR_RECHECK_CONF est recadré sur sa bbox, agrandi, et re-OCR en
// mode « mot unique » (PSM 8). On garde la lecture la plus sûre. Aucun mot n'est
// supprimé : on cherche juste à corriger un mot mal/partiellement lu.
const OCR_RECHECK_CONF = 75;   // on relit les mots dont la conf est SOUS ce seuil…
const OCR_RECHECK_MIN  = 25;   // …mais AU-DESSUS de celui-ci (sous 25 = bruit, inutile de relire)
const OCR_RECHECK_ZOOM = 3;    // agrandissement supplémentaire du mot
const OCR_RECHECK_PAD  = 6;    // marge autour de la bbox (px, repère image OCR)
const OCR_RECHECK_MAX  = 20;   // plafond de relectures (latence)

// Après relecture : un vrai mot relu en gros devient sûr ; le bruit reste bas.
// On élimine donc les mots ENCORE sous ce plancher (déchets « II », « 7Si »…).
const OCR_MIN_CONF = 45;
// Une bulle doit contenir un minimum de lettres, sinon c'est un fragment parasite.
const OCR_MIN_BUBBLE_LETTERS = 3;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Recadre la zone d'un mot depuis l'image OCR et la zoome (fond blanc).
function cropWordDataURL(img, bbox) {
  const sx = Math.max(0, bbox.x0 - OCR_RECHECK_PAD);
  const sy = Math.max(0, bbox.y0 - OCR_RECHECK_PAD);
  const sw = Math.min(img.width  - sx, (bbox.x1 - bbox.x0) + OCR_RECHECK_PAD * 2);
  const sh = Math.min(img.height - sy, (bbox.y1 - bbox.y0) + OCR_RECHECK_PAD * 2);
  if (sw <= 0 || sh <= 0) return null;
  const c = document.createElement('canvas');
  c.width  = Math.round(sw * OCR_RECHECK_ZOOM);
  c.height = Math.round(sh * OCR_RECHECK_ZOOM);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function recheckLowConfWords(words, ocrDataURL) {
  const targets = words.filter(w =>
    w.bbox && w.confidence >= OCR_RECHECK_MIN && w.confidence < OCR_RECHECK_CONF);
  if (!targets.length) return;

  const img = await loadImage(ocrDataURL);
  const worker = await getOcrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '8' }); // PSM_SINGLE_WORD
  try {
    for (const w of targets.slice(0, OCR_RECHECK_MAX)) {
      const crop = cropWordDataURL(img, w.bbox);
      if (!crop) continue;
      try {
        const { data } = await worker.recognize(crop, {}, { text: true });
        const cand = (data.text || '').trim().replace(/\s+/g, '');
        const conf = Math.round(data.confidence || 0);
        if (cand && conf > w.confidence) {
          console.log(`[Tesseract] relu "${w.text}" (${w.confidence}%) → "${cand}" (${conf}%)`);
          w.text = cand;
          w.confidence = conf;
        }
      } catch { /* on garde la lecture initiale */ }
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: OCR_PSM }); // restaurer
  }
}

// Debug : dernier OCR brut + gardé (diagnostic console uniquement).
let lastOcrDebug = '';

// OCR d'une image prétraitée → liste de mots {text, confidence, bbox} (sans regroupement).
// recheck=false : on saute la relecture par mot (passe de localisation / zone déjà zoomée).
async function ocrWords(dataURL, { recheck = true } = {}) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(dataURL, {}, { blocks: true, text: true });
  let words = extractAllWords(data);
  const rawStr = words.map(w => `${w.text}(${w.confidence})`).join('  ');
  if (recheck) await recheckLowConfWords(words, dataURL); // corrige les mots en place
  words = words.filter(w => w.confidence >= OCR_MIN_CONF); // élimine le bruit résiduel
  const keptStr = words.map(w => `${w.text}(${w.confidence})`).join('  ');
  return { words, rawStr, keptStr };
}

// Renvoie une liste de bulles : [{ confidence, words: [{text, confidence, bbox}] }]
async function ocrImage(dataURL, opts) {
  const { words, rawStr, keptStr } = await ocrWords(dataURL, opts);
  console.log('[MT] OCR brut :', rawStr);
  console.log('[MT] OCR gardé :', keptStr);
  lastOcrDebug = `BRUT  : ${rawStr || '(rien)'}\n\nGARDÉ : ${keptStr || '(rien)'}`;
  return groupWordsIntoBubbles(words);
}

// ── OCR double-polarité (recall) ───────────────────────────────────────────────
// Certaines bulles ne ressortent PAS du tout quand la polarité globale est mauvaise
// (page sombre + bulle claire, ou inverse) : Tesseract ne lit rien. On prétraite
// donc l'image dans LES DEUX sens (texte foncé / texte clair), on OCR chaque version
// et on fusionne par position (chaque bulle est lue dans le sens qui marche).
// a et b partagent le même repère (même upscale + marge) → bbox comparables.
function mergeWordsByPosition(a, b) {
  const kept = a.slice();
  for (const w of b) {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const tol = Math.max(8, w.bbox.y1 - w.bbox.y0);
    const dup = kept.find(k => {
      const kx = (k.bbox.x0 + k.bbox.x1) / 2, ky = (k.bbox.y0 + k.bbox.y1) / 2;
      return Math.abs(kx - cx) < tol && Math.abs(ky - cy) < tol;
    });
    if (dup) {
      if (w.confidence > dup.confidence) { dup.text = w.text; dup.confidence = w.confidence; dup.bbox = w.bbox; }
    } else {
      kept.push(w);
    }
  }
  return kept;
}

async function ocrWordsRobust(rawDataURL, { upscale = OCR_UPSCALE, recheck = true } = {}) {
  const [preNorm, preInv] = await Promise.all([
    preprocessImageForOCR(rawDataURL, upscale, false),
    preprocessImageForOCR(rawDataURL, upscale, true),
  ]);
  const A = await ocrWords(preNorm, { recheck });
  const B = await ocrWords(preInv,  { recheck });
  const words = mergeWordsByPosition(A.words, B.words);
  const rawStr  = [A.rawStr, B.rawStr].filter(Boolean).join('  ');
  const keptStr = words.map(w => `${w.text}(${w.confidence})`).join('  ');
  return { words, rawStr, keptStr };
}

// Comme ocrImage mais en double-polarité (meilleur recall).
async function ocrImageRobust(rawDataURL, opts) {
  const { words, rawStr, keptStr } = await ocrWordsRobust(rawDataURL, opts);
  console.log('[MT] OCR brut (2 polarités) :', rawStr);
  console.log('[MT] OCR gardé :', keptStr);
  lastOcrDebug = `BRUT  : ${rawStr || '(rien)'}\n\nGARDÉ : ${keptStr || '(rien)'}`;
  return groupWordsIntoBubbles(words);
}

// ── Zoom automatique sur chaque zone de texte (écran visible) ───────────────────
// Passe 1 : on localise les zones de texte sur l'image entière. Passe 2 : pour
// chaque zone détectée, on recadre l'image SOURCE sur la zone (jamais coupée, car
// alignée sur le texte) et on l'agrandit fort avant relecture — l'équivalent
// automatique d'une sélection de zone manuelle, répété sur toutes les bulles.
const ZONE_PAD    = 16;    // marge autour de la zone (px image source)
const ZONE_TARGET = 1400;  // grand côté visé de la zone agrandie (px)
const ZONE_MAX_UP = 10;    // facteur d'agrandissement max d'une zone

// bbox d'une bulle (mots en repère prétraité ×OCR_UPSCALE + marge) → repère source.
function bubbleBboxSource(bubble) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of bubble.words) {
    x0 = Math.min(x0, w.bbox.x0); y0 = Math.min(y0, w.bbox.y0);
    x1 = Math.max(x1, w.bbox.x1); y1 = Math.max(y1, w.bbox.y1);
  }
  const s = OCR_UPSCALE, m = OCR_MARGIN;
  return { x0: (x0 - m) / s, y0: (y0 - m) / s, x1: (x1 - m) / s, y1: (y1 - m) / s };
}

// Recadre un rectangle de l'image source (+ marge), bornes clampées.
function cropImageRect(img, bb, pad) {
  const x = Math.max(0, Math.floor(bb.x0 - pad));
  const y = Math.max(0, Math.floor(bb.y0 - pad));
  const x1 = Math.min(img.naturalWidth,  Math.ceil(bb.x1 + pad));
  const y1 = Math.min(img.naturalHeight, Math.ceil(bb.y1 + pad));
  const w = x1 - x, h = y1 - y;
  if (w <= 2 || h <= 2) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
  return { url: c.toDataURL('image/png'), w, h };
}

function avgConf(words) {
  return Math.round(words.reduce((s, w) => s + w.confidence, 0) / words.length);
}

async function ocrZonesZoomed(originalDataURL) {
  // Passe 1 — localisation en DOUBLE POLARITÉ (recall : ne rate pas les bulles
  // dont la polarité diffère du reste de la page), sans relecture par mot.
  const zones = await ocrImageRobust(originalDataURL, { recheck: false });
  if (!zones.length) return [];

  // Passe 2 — zoom + relecture de chaque zone sur l'image source.
  const origImg = await loadImage(originalDataURL);
  const refined = [];
  const dbgParts = [];
  for (let i = 0; i < zones.length; i++) {
    updateStatus(`Zoom des zones de texte… (${i + 1}/${zones.length})`);
    const bb = bubbleBboxSource(zones[i]);
    const crop = cropImageRect(origImg, bb, ZONE_PAD);
    let words = null;
    if (crop) {
      // Plus la zone est petite, plus on zoome (plafonné) → texte bien net.
      const up = Math.min(ZONE_MAX_UP, Math.max(OCR_UPSCALE, Math.round(ZONE_TARGET / Math.max(crop.w, crop.h))));
      const { words: zw, keptStr } = await ocrWordsRobust(crop.url, { upscale: up, recheck: false }).catch(() => ({ words: [], keptStr: '' }));
      if (zw.length) { words = zw; if (keptStr) dbgParts.push(keptStr); }
    }
    // On garde la bbox SOURCE de la zone (repère capture) → permet « Affiner » plus tard.
    refined.push(words ? { confidence: avgConf(words), words, bbox: bb } : { ...zones[i], bbox: bb });
  }
  if (dbgParts.length) lastOcrDebug += `\n\nZOOM  : ${dbgParts.join('  ')}`;
  console.log(`[MT] Zoom zones : ${zones.length} zone(s) relue(s)`);
  return refined;
}

function cleanOcrText(rawText) {
  return (rawText || '').replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// On ne supprime plus les mots par confiance (ça troue les phrases → mauvaises
// traductions). Les mots peu sûrs sont corrigés par recheckLowConfWords, pas jetés.
function wordsToText(words) {
  return words.map(w => w.text).join(' ');
}

// Garde un token s'il contient une lettre ET aucun chiffre (les dialogues manga
// n'ont quasi jamais de chiffres collés aux mots → "7Si", "2}" = bruit OCR).
function filterLexical(text) {
  return (text || '').split(' ').filter(t => /[a-zA-Z]/.test(t) && !/[0-9]/.test(t)).join(' ');
}

// Bruit d'interface (navigation de chapitres, menus, pub…). On masque déjà la
// plupart de ces éléments fixed/sticky à la capture ; ceci attrape le résidu.
// Liste volontairement restreinte à des mots qui n'apparaissent ~jamais en dialogue
// pur, OU dont on ne supprime la bulle QUE si TOUS les tokens sont de l'interface
// (donc "go home", "next time"… restent : ils ont d'autres mots).
const UI_STOPWORDS = new Set([
  'chapter', 'chapitre', 'chap', 'cap', 'episode', 'ep', 'volume', 'vol',
  'manga', 'mangas', 'manhwa', 'manhua', 'webtoon', 'webtoons', 'scan', 'scans',
  'prev', 'previous', 'next', 'home', 'menu', 'search', 'login', 'logout',
  'signin', 'signup', 'register', 'bookmark', 'bookmarks', 'comments', 'comment',
  'share', 'report', 'download', 'subscribe', 'advertisement', 'sponsored',
  'accueil', 'connexion', 'suivant', 'precedent', 'rechercher', 'telecharger',
]);

// Une bulle est du bruit d'interface si TOUS ses tokens sont des mots d'interface.
function isUiNoise(text) {
  const toks = (text || '').toLowerCase().split(/\s+/)
    .map(t => t.replace(/[^a-zà-ÿ]/gi, '')).filter(Boolean);
  return !toks.length || toks.every(t => UI_STOPWORDS.has(t));
}

// E-mail transmis à MyMemory (param `de=`) → quota gratuit ~10× supérieur.
// Par-utilisateur (réglages), jamais codé en dur. Vide ⇒ quota anonyme.
let myMemoryEmail = '';

async function translateWithMyMemory(text) {
  const de = myMemoryEmail ? `&de=${encodeURIComponent(myMemoryEmail)}` : '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|fr${de}`;
  let resp;
  try {
    resp = await fetch(url);
  } catch {
    throw new Error('MyMemory : erreur réseau');
  }
  if (!resp.ok) throw new Error(`MyMemory : HTTP ${resp.status}`);
  const data = await resp.json();
  const tr = data?.responseData?.translatedText;
  if (!tr) throw new Error('MyMemory : réponse vide');
  return tr;
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const captureBtn   = document.getElementById('captureBtn');

const stateEmpty    = document.getElementById('stateEmpty');
const stateProgress = document.getElementById('stateProgress');
const stateSelect   = document.getElementById('stateSelect');
const stateSuccess  = document.getElementById('stateSuccess');
const stateError    = document.getElementById('stateError');

const progressText  = document.getElementById('progressText');
const selectCanvas  = document.getElementById('selectCanvas');
const analyzeSelBtn = document.getElementById('analyzeSelBtn');
const analyzeAllBtn = document.getElementById('analyzeAllBtn');
const recaptureBtn  = document.getElementById('recaptureBtn');

const capturePreview  = document.getElementById('capturePreview');
const blocksContainer = document.getElementById('blocksContainer');
const blocksCount     = document.getElementById('blocksCount');
const errorMessage    = document.getElementById('errorMessage');
const copyAllBtn      = document.getElementById('copyAllBtn');
const newCaptureBtn   = document.getElementById('newCaptureBtn');
const retryBtn        = document.getElementById('retryBtn');

// Réglages
const settingsBtn      = document.getElementById('settingsBtn');
const settingsPanel    = document.getElementById('settingsPanel');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const modeLocal        = document.getElementById('modeLocal');
const modeAi           = document.getElementById('modeAi');
const aiKeySection     = document.getElementById('aiKeySection');
const aiProvidersList  = document.getElementById('aiProvidersList');
const myMemoryEmailInput = document.getElementById('myMemoryEmail');
const saveSettingsBtn  = document.getElementById('saveSettingsBtn');
const saveKeyMsg       = document.getElementById('saveKeyMsg');

// ── State ─────────────────────────────────────────────────────────────────────
let currentBlocks    = [];        // [{ en, fr, confidence }]
let capturedDataURL  = null;
let selectorInstance = null;
let _ocrGeneration   = 0;          // anti-race entre deux analyses
let translationMode  = 'local';    // 'local' (Tesseract+MyMemory) | 'ai' (fournisseurs)
let aiKeys           = {};          // { gemini, openai, anthropic, mistral, groq }
let aiEnabled        = {};          // { <id>: bool } — fournisseurs actifs (bascule)

const ALL_STATES = [stateEmpty, stateProgress, stateSelect, stateSuccess, stateError];

// ── UI helpers ─────────────────────────────────────────────────────────────────
function showState(el) {
  ALL_STATES.forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function setLoading(loading) {
  captureBtn.disabled = loading;
}

function updateStatus(text) {
  progressText.textContent = text;
  showState(stateProgress);
}

function showError(msg) {
  errorMessage.textContent = msg || 'Erreur inconnue — voir la console pour les détails.';
  showState(stateError);
}

function errMsg(err) {
  return (err instanceof Error ? err.message : String(err)) || 'Erreur inconnue';
}

// ── Réglages (mode + fournisseurs IA multi-clés) ──────────────────────────────
function openSettings()  { settingsPanel.classList.remove('hidden'); }
function closeSettings() { settingsPanel.classList.add('hidden'); }

function updateModeUI() {
  modeLocal.checked = translationMode === 'local';
  modeAi.checked    = translationMode === 'ai';
  aiKeySection.classList.toggle('hidden', translationMode !== 'ai');
}

// Construit une ligne par fournisseur (case activer + champ clé + lien).
function buildProviderRows() {
  aiProvidersList.innerHTML = '';
  for (const [id, meta] of Object.entries(AI_PROVIDERS)) {
    const row = document.createElement('div');
    row.className = 'provider-row';
    row.innerHTML = `
      <label class="provider-head">
        <input type="checkbox" class="provider-toggle" data-prov="${id}">
        <span class="provider-name">${meta.label} <small>${meta.note}</small></span>
      </label>
      <div class="api-key-row">
        <input type="password" class="api-key-input provider-key" data-prov="${id}"
               placeholder="${meta.keyHint}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn-toggle-key" title="Afficher / masquer">👁</button>
      </div>
      <a class="settings-link" href="${meta.keyUrl}" target="_blank" rel="noopener">${meta.noKey ? 'Installer →' : 'Obtenir une clé →'}</a>
    `;
    row.querySelector('.provider-toggle').checked = !!aiEnabled[id];
    row.querySelector('.provider-key').value = aiKeys[id] || '';
    row.querySelector('.btn-toggle-key').addEventListener('click', () => {
      const inp = row.querySelector('.provider-key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    aiProvidersList.appendChild(row);
  }
}

async function loadSettings() {
  const data = await new Promise(r =>
    chrome.storage.local.get(['translationMode', 'aiKeys', 'aiEnabled', 'geminiApiKey', 'myMemoryEmail'], r));
  translationMode = data.translationMode === 'ai' ? 'ai' : 'local';
  aiKeys    = data.aiKeys    || {};
  aiEnabled = data.aiEnabled || {};
  myMemoryEmail = data.myMemoryEmail || '';
  if (myMemoryEmailInput) myMemoryEmailInput.value = myMemoryEmail;
  // Migration de l'ancienne clé unique Gemini.
  if (data.geminiApiKey && !aiKeys.gemini) { aiKeys.gemini = data.geminiApiKey; aiEnabled.gemini = true; }
  buildProviderRows();
  updateModeUI();
}

function showSaveMsg(text, ok) {
  saveKeyMsg.textContent = text;
  saveKeyMsg.className = `save-key-msg ${ok ? 'save-key-ok' : 'save-key-err'}`;
  saveKeyMsg.classList.remove('hidden');
  setTimeout(() => saveKeyMsg.classList.add('hidden'), 3000);
}

async function saveSettings() {
  const mode = modeAi.checked ? 'ai' : 'local';
  const keys = {}, enabled = {};
  aiProvidersList.querySelectorAll('.provider-row').forEach(row => {
    const id = row.querySelector('.provider-key').dataset.prov;
    keys[id]    = row.querySelector('.provider-key').value.trim();
    enabled[id] = row.querySelector('.provider-toggle').checked;
  });
  if (mode === 'ai' && !Object.keys(AI_PROVIDERS).some(id => enabled[id] && (keys[id] || AI_PROVIDERS[id].noKey))) {
    showSaveMsg('Active au moins un fournisseur IA (avec une clé, ou un local).', false);
    return;
  }
  myMemoryEmail = (myMemoryEmailInput?.value || '').trim();
  translationMode = mode; aiKeys = keys; aiEnabled = enabled;
  await new Promise(r => chrome.storage.local.set({ translationMode: mode, aiKeys: keys, aiEnabled: enabled, myMemoryEmail }, r));
  showSaveMsg('Réglages enregistrés !', true);
  setTimeout(closeSettings, 800);
}

// Fournisseurs activés ET avec clé, dans l'ordre de bascule.
function aiChain() {
  return Object.keys(AI_PROVIDERS)
    .filter(id => aiEnabled[id] && (aiKeys[id] || AI_PROVIDERS[id].noKey))
    .map(id => ({ id, key: aiKeys[id] || '', model: AI_PROVIDERS[id].model }));
}

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
modeLocal.addEventListener('change', () => aiKeySection.classList.add('hidden'));
modeAi.addEventListener('change', () => aiKeySection.classList.remove('hidden'));
saveSettingsBtn.addEventListener('click', saveSettings);

// ── Mode IA : resize + appel fournisseur (avec bascule) ───────────────────────
// Vise une largeur cible (upscale petits crops, downscale grandes images) ; JPEG
// pour limiter les tokens. Seul le mode IA l'utilise.
function resizeForGemini(dataURL, { minWidth = 1200, maxWidth = 1536, maxHeight = 14000, maxUpscale = 6, quality = 0.9 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let scale = img.width < minWidth ? Math.min(minWidth / img.width, maxUpscale) : 1;
      scale = Math.min(scale, maxWidth / img.width, maxHeight / img.height);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

async function analyzeWithAI(imageUrl) {
  updateStatus('Optimisation de l\'image…');
  const b64 = (await resizeForGemini(imageUrl)).split(',')[1];

  const chain = aiChain();
  if (!chain.length) throw aiError('Aucun fournisseur IA configuré. Ouvre ⚙️ Réglages.', 'NO_KEY');

  // Bascule : on essaie chaque fournisseur dans l'ordre ; au moindre échec (quota,
  // clé, réseau…) on passe au suivant. On ne lève qu'après les avoir tous tentés.
  let lastErr;
  for (const p of chain) {
    try {
      updateStatus(`Analyse IA — ${AI_PROVIDERS[p.id].label}…`);
      const blocks = await analyzeWithProvider(p.id, p.key, p.model, b64, 'image/jpeg');
      return blocks.map(b => ({ en: b.en, fr: b.fr, lang: b.lang }));
    } catch (err) {
      lastErr = err;
      console.warn(`[MT] ${p.id} a échoué (${err.code || '?'}) :`, err.message);
    }
  }
  throw lastErr || aiError('Tous les fournisseurs IA ont échoué.', 'ALL_FAILED');
}

// ── Régions OCR → bulles affichables ──────────────────────────────────────────
// Confiance sous laquelle une carte est signalée comme « à affiner » (UI).
const LOW_CONF = 70;
// Bruit OCR typique (onomatopées mal lues, ex. « row » pour 척!) : court ET peu sûr.
const NOISE_CONF = 50;
const NOISE_MAX_LETTERS = 3;

function isLowConfNoise(b) {
  if (b.confidence == null) return false;
  const letters = (b.en.match(/[a-zA-Z]/g) || []).length;
  return b.confidence < NOISE_CONF && letters <= NOISE_MAX_LETTERS;
}

function regionsToBubbles(regions) {
  return regions
    .map(r => ({ confidence: r.confidence, en: cleanOcrText(filterLexical(wordsToText(r.words))), bbox: r.bbox }))
    .filter(b => (b.en.match(/[a-zA-Z]/g) || []).length >= OCR_MIN_BUBBLE_LETTERS)
    .filter(b => !isUiNoise(b.en))
    .filter(b => !isLowConfNoise(b));
}

// ── Mode écran visible ─────────────────────────────────────────────────────────
async function runVisibleCapture() {
  setLoading(true);
  try {
    updateStatus('Capture en cours…');
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
    if (!result?.ok) throw new Error(result?.error || 'Aucune réponse. Recharge l\'extension.');
    capturedDataURL = result.data.dataURL;
    await showSelectState(capturedDataURL);
  } catch (err) {
    console.error('[MT] Erreur capture:', err);
    showError(errMsg(err));
  } finally {
    setLoading(false);
  }
}

async function showSelectState(dataURL) {
  showState(stateSelect);
  await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (selectorInstance) { selectorInstance.destroy(); selectorInstance = null; }
      selectorInstance = new SelectionCanvas(selectCanvas, img);
      resolve();
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// ── Analyse (depuis le sélecteur de zone) ─────────────────────────────────────
async function runAnalysis(selection) {
  if (!capturedDataURL) { showState(stateEmpty); return; }

  setLoading(true);
  try {
    let imageUrl = capturedDataURL;
    if (selection) {
      updateStatus('Découpe de la zone…');
      imageUrl = await cropImage(capturedDataURL, selection);
    }

    if (translationMode === 'ai') {
      const blocks = await analyzeWithAI(imageUrl);
      console.log('[MT] IA:', blocks.length, 'bloc(s)');
      renderCards(capturedDataURL, null, blocks, false);
    } else {
      let regions;
      if (selection) {
        // Sélection manuelle : zoom adaptatif + double-polarité + relecture par mot
        // (recheck) → le mode le plus précis ET le plus fiable, bulle par bulle.
        updateStatus('OCR en cours…');
        const up = Math.min(ZONE_MAX_UP, Math.max(OCR_UPSCALE, Math.round(ZONE_TARGET / Math.max(1, selection.w, selection.h))));
        regions = await ocrImageRobust(imageUrl, { upscale: up, recheck: true });
      } else {
        // « Analyser tout » : détection des zones puis zoom auto sur chacune.
        updateStatus('Détection des zones de texte…');
        regions = await ocrZonesZoomed(imageUrl);
      }
      const bubbles = regionsToBubbles(regions);
      console.log('[MT] OCR:', bubbles.length, 'bulle(s)');
      renderCards(capturedDataURL, null, bubbles, true);
    }
  } catch (err) {
    console.error('[MT] Erreur analyse:', err);
    showError(errMsg(err));
    if (err.code === 'NO_KEY' || err.code === 'INVALID_KEY') openSettings();
  } finally {
    setLoading(false);
  }
}

function cropImage(dataURL, { x, y, w, h }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// ── Résultats (commun aux deux modes) ─────────────────────────────────────────
// items : [{ en, fr?, confidence? }]. isLocal = mode Tesseract (fr à traduire via
// MyMemory, de façon asynchrone) ; sinon mode IA (fr déjà fourni par Gemini).
function renderCards(previewUrl, _preprocessedUrl, items, isLocal) {
  const gen = ++_ocrGeneration;
  capturePreview.src = previewUrl;

  currentBlocks = items.map(b => ({ en: b.en, fr: b.fr || '', lang: b.lang, confidence: b.confidence, bbox: b.bbox }));
  blocksContainer.innerHTML = '';

  if (!items.length) {
    blocksCount.textContent = 'Aucun texte détecté';
    blocksContainer.innerHTML = '<p class="no-text-msg">Aucun texte détecté.<br>Essaie une zone plus précise.</p>';
    showState(stateSuccess);
    return;
  }

  const n = items.length;
  blocksCount.textContent = `${n} bulle${n > 1 ? 's' : ''} traduite${n > 1 ? 's' : ''}`;
  showState(stateSuccess);

  items.forEach((b, i) => {
    const card = createBlockCard(b, i);
    blocksContainer.appendChild(card);
    // Mode local : la traduction MyMemory arrive de façon asynchrone.
    if (isLocal) {
      const frEl = card.querySelector('.block-fr-text');
      translateWithMyMemory(b.en)
        .then(fr  => { if (gen !== _ocrGeneration) return; currentBlocks[i].fr = fr; frEl.textContent = fr; })
        .catch(err => { if (gen !== _ocrGeneration) return; frEl.textContent = errMsg(err); });
    }
  });
}

// Niveau de confiance OCR → classe couleur (vert / orange / rouge).
function confClass(c) {
  return c >= 75 ? 'conf-high' : c >= 50 ? 'conf-mid' : 'conf-low';
}

// ── Carte de bulle ──────────────────────────────────────────────────────────────
// Drapeau de la langue source. Mode local = OCR anglais seul ⇒ pas de `lang` ⇒ 🇬🇧.
// Mode IA = `lang` (code ISO 639-1) renvoyé par le modèle ⇒ drapeau correspondant.
const LANG_FLAGS = {
  en: '🇬🇧', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', fr: '🇫🇷', es: '🇪🇸', de: '🇩🇪',
  it: '🇮🇹', pt: '🇵🇹', ru: '🇷🇺', nl: '🇳🇱', th: '🇹🇭', vi: '🇻🇳', ar: '🇸🇦',
};
function langToFlag(lang) {
  if (!lang) return '🇬🇧';                 // pas de code (mode local) → anglais par défaut
  return LANG_FLAGS[lang.slice(0, 2)] || '🌐'; // code connu → son drapeau, sinon générique
}

function createBlockCard(block, index) {
  const card = document.createElement('div');
  card.className = 'block-card';
  card.id = `block-card-${index}`;
  card.style.animationDelay = `${Math.min(index * 40, 400)}ms`;

  const hasConf   = block.confidence != null;
  const isLowConf = hasConf && block.confidence < LOW_CONF;
  if (isLowConf) card.classList.add('low-conf');
  const frText = block.fr ? escapeHtml(block.fr) : '<span class="block-pending">Traduction…</span>';

  card.innerHTML = `
    <div class="block-header">
      <span class="block-num">${index + 1}</span>
      <div class="block-header-right">
        ${isLowConf ? '<button class="btn-refine" title="Améliorer cette zone (zoom + relecture)">🔍 Affiner</button>' : ''}
        ${hasConf ? `<span class="block-conf ${confClass(block.confidence)}">${block.confidence}%</span>` : ''}
      </div>
    </div>
    <div class="block-lang block-fr">
      <span class="lang-flag">🇫🇷</span>
      <p class="block-lang-text block-fr-text">${frText}</p>
      <button class="btn-copy-block btn-copy-fr" title="Copier la traduction">⧉</button>
    </div>
    <div class="block-lang block-en">
      <span class="lang-flag">${langToFlag(block.lang)}</span>
      <p class="block-lang-text block-en-text">${escapeHtml(block.en)}</p>
      <button class="btn-copy-block btn-copy-en" title="Copier l'original">⧉</button>
    </div>
  `;

  card.querySelector('.btn-copy-en').addEventListener('click', e => copyToClipboard(block.en, e.currentTarget));
  card.querySelector('.btn-copy-fr').addEventListener('click', e => copyToClipboard(currentBlocks[index]?.fr || '', e.currentTarget));
  const refineBtn = card.querySelector('.btn-refine');
  if (refineBtn) refineBtn.addEventListener('click', () => refineBubble(index));

  return card;
}

// « Affiner » : re-lit une zone peu sûre en la zoomant au max sur la capture.
// Si on connaît la position de la bulle (mode « Toute l'image ») → relecture auto
// d'un seul clic, mise à jour de la carte. Sinon → retour au sélecteur manuel.
async function refineBubble(index) {
  const block = currentBlocks[index];
  const card  = document.getElementById(`block-card-${index}`);
  if (!block || !card) return;

  if (!block.bbox || !capturedDataURL) {           // pas de position connue → sélection manuelle
    if (capturedDataURL) showSelectState(capturedDataURL);
    return;
  }

  const gen = _ocrGeneration;
  const btn = card.querySelector('.btn-refine');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const bb  = block.bbox;
    const pad = Math.round(Math.max(8, (bb.y1 - bb.y0) * 0.4));
    const sel = {
      x: Math.max(0, Math.round(bb.x0 - pad)),
      y: Math.max(0, Math.round(bb.y0 - pad)),
      w: Math.round((bb.x1 - bb.x0) + pad * 2),
      h: Math.round((bb.y1 - bb.y0) + pad * 2),
    };
    const crop = await cropImage(capturedDataURL, sel);
    const up   = Math.min(ZONE_MAX_UP, Math.max(OCR_UPSCALE, Math.round(ZONE_TARGET / Math.max(1, Math.max(sel.w, sel.h)))));
    // double-polarité + zoom + relecture par mot → recall et précision max
    const bubbles = regionsToBubbles(await ocrImageRobust(crop, { upscale: up, recheck: true }));
    if (gen !== _ocrGeneration) return;                      // résultats périmés

    const en = bubbles.map(b => b.en).join(' ').trim();
    if (!en) return;                                         // rien de mieux → on garde l'existant
    const conf = bubbles.length
      ? Math.round(bubbles.reduce((s, b) => s + (b.confidence || 0), 0) / bubbles.length)
      : block.confidence;

    block.en = en; block.confidence = conf;
    card.querySelector('.block-en-text').textContent = en;
    const confEl = card.querySelector('.block-conf');
    if (confEl) { confEl.textContent = `${conf}%`; confEl.className = `block-conf ${confClass(conf)}`; }
    card.classList.toggle('low-conf', conf != null && conf < LOW_CONF);

    const frEl = card.querySelector('.block-fr-text');
    frEl.innerHTML = '<span class="block-pending">Traduction…</span>';
    translateWithMyMemory(en)
      .then(fr  => { if (gen !== _ocrGeneration) return; block.fr = fr; frEl.textContent = fr; })
      .catch(err => { if (gen !== _ocrGeneration) return; frEl.textContent = errMsg(err); });
  } catch (err) {
    console.error('[MT] Affiner:', err);
  } finally {
    const b2 = card.querySelector('.btn-refine');
    if (b2) { b2.disabled = false; b2.textContent = '🔍 Affiner'; }
  }
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Clipboard ──────────────────────────────────────────────────────────────────
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('btn-copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('btn-copied'); }, 1500);
  } catch (err) { console.error('[MT] Clipboard:', err); }
}

// ── Écouteurs ──────────────────────────────────────────────────────────────────
captureBtn.addEventListener('click', runVisibleCapture);

analyzeSelBtn.addEventListener('click', () => {
  const sel = selectorInstance?.getRealSelection();
  runAnalysis(sel);
});
analyzeAllBtn.addEventListener('click', () => runAnalysis(null));
recaptureBtn.addEventListener('click', runVisibleCapture);

copyAllBtn.addEventListener('click', e => {
  const all = currentBlocks.map(b => `${langToFlag(b.lang)} ${b.en}\n🇫🇷 ${b.fr}`).join('\n\n');
  copyToClipboard(all, e.currentTarget);
});

newCaptureBtn.addEventListener('click', () => showState(stateEmpty));

retryBtn.addEventListener('click', () => {
  if (capturedDataURL) showSelectState(capturedDataURL);
  else showState(stateEmpty);
});

// ── Init ───────────────────────────────────────────────────────────────────────
loadSettings();
showState(stateEmpty);
