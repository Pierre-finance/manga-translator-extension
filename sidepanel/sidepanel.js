// ── Prétraitement image pour OCR ───────────────────────────────────────────────
// Upscale ×4 → niveaux de gris (PAS de binarisation Otsu : le LSTM de Tesseract
// préfère le gris à du N&B dur, l'anti-aliasing l'aide) → polarité → marge blanche.
const OCR_UPSCALE = 4;
const OCR_MARGIN  = 24;   // marge blanche autour du texte (px, sur l'image agrandie)

function preprocessImageForOCR(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width  * OCR_UPSCALE;
      const h = img.height * OCR_UPSCALE;
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
      const invert = (sum / n) < 128;
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

// Debug : dernier OCR brut + gardé (affiché dans le panneau pour diagnostic).
let lastOcrDebug = '';

// Renvoie une liste de bulles : [{ confidence, words: [{text, confidence, bbox}] }]
async function ocrImage(dataURL) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(dataURL, {}, { blocks: true, text: true });
  let words = extractAllWords(data);
  const rawStr = words.map(w => `${w.text}(${w.confidence})`).join('  ');
  console.log('[MT] OCR brut :', rawStr);
  await recheckLowConfWords(words, dataURL);          // 1. corrige les mots en place
  words = words.filter(w => w.confidence >= OCR_MIN_CONF);  // 2. élimine le bruit résiduel
  const keptStr = words.map(w => `${w.text}(${w.confidence})`).join('  ');
  console.log('[MT] OCR gardé :', keptStr);
  lastOcrDebug = `BRUT  : ${rawStr || '(rien)'}\n\nGARDÉ : ${keptStr || '(rien)'}`;
  return groupWordsIntoBubbles(words);                // 3. regroupe en bulles
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

// E-mail transmis à MyMemory (param `de=`) → quota gratuit ~10× supérieur.
const MYMEMORY_EMAIL = 'pierredureux59@gmail.com';

async function translateWithMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|fr&de=${encodeURIComponent(MYMEMORY_EMAIL)}`;
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
const fullPageBtn  = document.getElementById('fullPageBtn');
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

const capturePreview       = document.getElementById('capturePreview');
const debugPreprocessWrap  = document.getElementById('debugPreprocessWrap');
const debugPreprocessImg   = document.getElementById('debugPreprocessImg');
const debugRawWrap         = document.getElementById('debugRawWrap');
const debugRawText         = document.getElementById('debugRawText');
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
const apiKeyInput      = document.getElementById('apiKeyInput');
const toggleKeyBtn     = document.getElementById('toggleKeyBtn');
const saveSettingsBtn  = document.getElementById('saveSettingsBtn');
const saveKeyMsg       = document.getElementById('saveKeyMsg');

// ── State ─────────────────────────────────────────────────────────────────────
let currentBlocks    = [];        // [{ en, fr, confidence }]
let capturedDataURL  = null;
let selectorInstance = null;
let _ocrGeneration   = 0;          // anti-race entre deux analyses
let translationMode  = 'local';    // 'local' (Tesseract+MyMemory) | 'ai' (Gemini)

const ALL_STATES = [stateEmpty, stateProgress, stateSelect, stateSuccess, stateError];

// ── UI helpers ─────────────────────────────────────────────────────────────────
function showState(el) {
  ALL_STATES.forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function setLoading(loading) {
  fullPageBtn.disabled = loading;
  captureBtn.disabled  = loading;
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

// ── Réglages (mode de traduction + clé Gemini) ────────────────────────────────
function openSettings()  { settingsPanel.classList.remove('hidden'); }
function closeSettings() { settingsPanel.classList.add('hidden'); }

function updateModeUI() {
  modeLocal.checked = translationMode === 'local';
  modeAi.checked    = translationMode === 'ai';
  aiKeySection.classList.toggle('hidden', translationMode !== 'ai');
}

async function loadSettings() {
  const data = await new Promise(r =>
    chrome.storage.local.get(['translationMode', 'geminiApiKey'], r));
  translationMode = data.translationMode === 'ai' ? 'ai' : 'local';
  if (data.geminiApiKey) apiKeyInput.value = data.geminiApiKey;
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
  const key  = apiKeyInput.value.trim();
  if (mode === 'ai' && !key) {
    showSaveMsg('Le mode IA nécessite une clé API.', false);
    return;
  }
  translationMode = mode;
  await new Promise(r => chrome.storage.local.set({ translationMode: mode, geminiApiKey: key }, r));
  showSaveMsg('Réglages enregistrés !', true);
  setTimeout(closeSettings, 800);
}

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);
modeLocal.addEventListener('change', () => aiKeySection.classList.add('hidden'));
modeAi.addEventListener('change', () => aiKeySection.classList.remove('hidden'));
saveSettingsBtn.addEventListener('click', saveSettings);
toggleKeyBtn.addEventListener('click', () => {
  const isPass = apiKeyInput.type === 'password';
  apiKeyInput.type = isPass ? 'text' : 'password';
  toggleKeyBtn.textContent = isPass ? '🙈' : '👁';
});

// ── Mode IA : resize + appel Gemini ───────────────────────────────────────────
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
  const resized = await resizeForGemini(imageUrl);
  updateStatus('Analyse par l\'IA…');
  const blocks = await analyzeImage(resized.split(',')[1], 'image/jpeg');
  // Gemini renvoie déjà { en, fr } ; on harmonise (pas de confiance).
  return blocks.map(b => ({ en: b.en, fr: b.fr }));
}

// ── Régions OCR → bulles affichables ──────────────────────────────────────────
function regionsToBubbles(regions) {
  return regions
    .map(r => ({ confidence: r.confidence, en: cleanOcrText(filterLexical(wordsToText(r.words))) }))
    .filter(b => (b.en.match(/[a-zA-Z]/g) || []).length >= OCR_MIN_BUBBLE_LETTERS);
}

// ── Mode page entière ──────────────────────────────────────────────────────────
async function runFullPagePipeline() {
  setLoading(true);

  const progressHandler = msg => {
    if (msg.type === 'CAPTURE_PROGRESS') {
      updateStatus(`Capture de la page… (${msg.step}/${msg.total})`);
    }
  };
  chrome.runtime.onMessage.addListener(progressHandler);

  try {
    updateStatus('Initialisation…');
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_FULL_PAGE' }, response => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });

    if (!result?.ok) throw new Error(result?.error || 'Capture page entière échouée.');

    const { images, captureCount } = result.data;
    capturedDataURL = images[0]; // première image pour la prévisualisation
    console.log(`[MT] Page entière reçue: ${captureCount} palier(s), ${images.length} segment(s)`);

    if (translationMode === 'ai') {
      let blocks = [];
      for (let i = 0; i < images.length; i++) {
        if (images.length > 1) updateStatus(`Analyse IA… (segment ${i + 1}/${images.length})`);
        blocks = blocks.concat(await analyzeWithAI(images[i]));
      }
      console.log('[MT] IA page entière:', blocks.length, 'bloc(s)');
      renderCards(capturedDataURL, null, blocks, false);
    } else {
      let allBubbles = [];
      let lastPreprocessed = null;
      for (let i = 0; i < images.length; i++) {
        updateStatus(`OCR… (segment ${i + 1}/${images.length})`);
        const preprocessed = await preprocessImageForOCR(images[i]).catch(() => null);
        if (!preprocessed) continue;
        lastPreprocessed = preprocessed;
        const regions = await ocrImage(preprocessed);
        allBubbles = allBubbles.concat(regionsToBubbles(regions));
      }
      console.log('[MT] OCR page entière:', allBubbles.length, 'bulle(s)');
      renderCards(capturedDataURL, lastPreprocessed, allBubbles, true);
    }
  } catch (err) {
    console.error('[MT] Erreur page entière:', err);
    showError(errMsg(err));
    if (err.code === 'NO_KEY' || err.code === 'INVALID_KEY') openSettings();
  } finally {
    chrome.runtime.onMessage.removeListener(progressHandler);
    setLoading(false);
  }
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
      updateStatus('Prétraitement de l\'image…');
      const preprocessed = await preprocessImageForOCR(imageUrl).catch(() => null);
      if (!preprocessed) throw new Error('Échec du prétraitement de l\'image.');
      updateStatus('OCR en cours…');
      const regions = await ocrImage(preprocessed);
      const bubbles = regionsToBubbles(regions);
      console.log('[MT] OCR:', bubbles.length, 'bulle(s)');
      renderCards(capturedDataURL, preprocessed, bubbles, true);
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

// ── Aperçu debug prétraitement ─────────────────────────────────────────────────
function showDebugPreview(url) {
  if (!url) { debugPreprocessWrap.classList.add('hidden'); return; }
  debugPreprocessImg.src = url;
  debugPreprocessWrap.classList.remove('hidden');
}

function hideDebugPreview() {
  debugPreprocessWrap.classList.add('hidden');
}

// ── Résultats (commun aux deux modes) ─────────────────────────────────────────
// items : [{ en, fr?, confidence? }]. isLocal = mode Tesseract (fr à traduire via
// MyMemory + affichage debug) ; sinon mode IA (fr déjà fourni par Gemini).
function renderCards(previewUrl, preprocessedUrl, items, isLocal) {
  const gen = ++_ocrGeneration;
  capturePreview.src = previewUrl;

  if (isLocal) {
    showDebugPreview(preprocessedUrl);
    debugRawText.textContent = lastOcrDebug || '(aucun)';
    debugRawWrap.classList.remove('hidden');
  } else {
    hideDebugPreview();
    debugRawWrap.classList.add('hidden');
  }

  currentBlocks = items.map(b => ({ en: b.en, fr: b.fr || '', confidence: b.confidence }));
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

// ── Carte de bulle ──────────────────────────────────────────────────────────────
function createBlockCard(block, index) {
  const card = document.createElement('div');
  card.className = 'block-card';
  card.id = `block-card-${index}`;

  const hasConf = block.confidence != null;
  const frText  = block.fr ? escapeHtml(block.fr) : '⏳…';

  card.innerHTML = `
    <div class="block-header">
      <span class="block-num">${hasConf ? '🔤 Bulle' : '#'}${index + 1}</span>
      ${hasConf ? `<span class="block-conf">conf ${block.confidence}%</span>` : ''}
    </div>
    <div class="block-lang block-en">
      <span class="lang-flag">🇬🇧</span>
      <p class="block-lang-text block-en-text">${escapeHtml(block.en)}</p>
      <button class="btn-copy-block btn-copy-en">Copier</button>
    </div>
    <div class="block-lang block-fr">
      <span class="lang-flag">🇫🇷</span>
      <p class="block-lang-text block-fr-text">${frText}</p>
      <button class="btn-copy-block btn-copy-fr">Copier</button>
    </div>
  `;

  card.querySelector('.btn-copy-en').addEventListener('click', e => copyToClipboard(block.en, e.currentTarget));
  card.querySelector('.btn-copy-fr').addEventListener('click', e => copyToClipboard(currentBlocks[index]?.fr || '', e.currentTarget));

  return card;
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
fullPageBtn.addEventListener('click', runFullPagePipeline);
captureBtn.addEventListener('click', runVisibleCapture);

analyzeSelBtn.addEventListener('click', () => {
  const sel = selectorInstance?.getRealSelection();
  runAnalysis(sel);
});
analyzeAllBtn.addEventListener('click', () => runAnalysis(null));
recaptureBtn.addEventListener('click', runVisibleCapture);

copyAllBtn.addEventListener('click', e => {
  const all = currentBlocks.map(b => `🇬🇧 ${b.en}\n🇫🇷 ${b.fr}`).join('\n\n');
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
