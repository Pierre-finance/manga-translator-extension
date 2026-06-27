// ── Manga Translator — version web (PWA) ────────────────────────────────────────
// Réutilise le pipeline de l'extension (OCR local Tesseract + zoom par zone +
// double-polarité + MyMemory) et les fournisseurs IA (providers.js). Différences :
//  - pas de chrome.* : stockage via localStorage, image fournie par l'utilisateur.
//  - Tesseract chargé via chemins relatifs (TESS_BASE) au lieu de chrome.runtime.getURL.
//  - les fournisseurs LOCAUX (Ollama/LM Studio) sont masqués (injoignables sur mobile).

// ── Prétraitement (identique extension) ─────────────────────────────────────────
const OCR_UPSCALE = 4;
const OCR_MARGIN  = 24;

function preprocessImageForOCR(dataURL, upscale = OCR_UPSCALE, forceInvert = null) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width * upscale, h = img.height * upscale;
      const c = document.createElement('canvas');
      c.width = w + OCR_MARGIN * 2; c.height = h + OCR_MARGIN * 2;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, OCR_MARGIN, OCR_MARGIN, w, h);
      const area = ctx.getImageData(OCR_MARGIN, OCR_MARGIN, w, h);
      const d = area.data, n = w * h;
      const gray = new Uint8Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const g = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
        gray[i] = g; sum += g;
      }
      const invert = forceInvert === null ? (sum / n) < 128 : forceInvert;
      for (let i = 0; i < n; i++) {
        const v = invert ? 255 - gray[i] : gray[i];
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
      }
      ctx.putImageData(area, OCR_MARGIN, OCR_MARGIN);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// ── Worker Tesseract (chemins web relatifs) ─────────────────────────────────────
const TESS_BASE = new URL('../lib/tesseract/', location.href).href;
const OCR_PSM = '11';
let _tesseractWorker = null;

async function getOcrWorker() {
  if (_tesseractWorker) return _tesseractWorker;
  _tesseractWorker = await Tesseract.createWorker('eng', 1, {
    workerPath: TESS_BASE + 'worker.min.js',
    corePath:   TESS_BASE,
    langPath:   TESS_BASE + 'lang/',
    workerBlobURL: false,
    gzip: false,
    logger: m => { if (m.status === 'recognizing text') setStatus(`OCR… ${Math.round(m.progress * 100)}%`); },
  });
  await _tesseractWorker.setParameters({ tessedit_pageseg_mode: OCR_PSM });
  return _tesseractWorker;
}

function extractAllWords(data) {
  const words = [];
  for (const b of (data.blocks || []))
    for (const p of (b.paragraphs || []))
      for (const l of (p.lines || []))
        for (const w of (l.words || []))
          if (w.bbox && w.text) words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox });
  if (!words.length && data.words)
    for (const w of data.words)
      if (w.bbox && w.text) words.push({ text: w.text, confidence: w.confidence, bbox: w.bbox });
  return words;
}

// ── Regroupement spatial en bulles ──────────────────────────────────────────────
const BUBBLE_GAP_FACTOR = 1.3;
function groupWordsIntoBubbles(words) {
  if (!words.length) return [];
  const heights = words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 1;
  const gapThreshold = medianH * BUBBLE_GAP_FACTOR;
  const lines = [];
  for (const w of [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    let line = lines.find(L => cy >= L.y0 && cy <= L.y1);
    if (!line) { line = { y0: w.bbox.y0, y1: w.bbox.y1, words: [] }; lines.push(line); }
    line.words.push(w);
    line.y0 = Math.min(line.y0, w.bbox.y0); line.y1 = Math.max(line.y1, w.bbox.y1);
  }
  lines.sort((a, b) => a.y0 - b.y0);
  const bubbles = [];
  let cur = null;
  for (const line of lines) {
    if (cur && (line.y0 - cur.y1) > gapThreshold) cur = null;
    if (!cur) { cur = { y1: line.y1, lines: [] }; bubbles.push(cur); }
    cur.lines.push(line);
    cur.y1 = Math.max(cur.y1, line.y1);
  }
  return bubbles.map(bub => {
    const ws = [];
    for (const line of bub.lines) { line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0); ws.push(...line.words); }
    const conf = Math.round(ws.reduce((s, w) => s + w.confidence, 0) / ws.length);
    return { confidence: conf, words: ws };
  });
}

// ── Relecture zoomée des mots peu sûrs ──────────────────────────────────────────
const OCR_RECHECK_CONF = 75, OCR_RECHECK_MIN = 25, OCR_RECHECK_ZOOM = 3, OCR_RECHECK_PAD = 6, OCR_RECHECK_MAX = 20;
const OCR_MIN_CONF = 45, OCR_MIN_BUBBLE_LETTERS = 3;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img); img.onerror = reject; img.src = src;
  });
}

function cropWordDataURL(img, bbox) {
  const sx = Math.max(0, bbox.x0 - OCR_RECHECK_PAD), sy = Math.max(0, bbox.y0 - OCR_RECHECK_PAD);
  const sw = Math.min(img.width - sx, (bbox.x1 - bbox.x0) + OCR_RECHECK_PAD * 2);
  const sh = Math.min(img.height - sy, (bbox.y1 - bbox.y0) + OCR_RECHECK_PAD * 2);
  if (sw <= 0 || sh <= 0) return null;
  const c = document.createElement('canvas');
  c.width = Math.round(sw * OCR_RECHECK_ZOOM); c.height = Math.round(sh * OCR_RECHECK_ZOOM);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function recheckLowConfWords(words, ocrDataURL) {
  const targets = words.filter(w => w.bbox && w.confidence >= OCR_RECHECK_MIN && w.confidence < OCR_RECHECK_CONF);
  if (!targets.length) return;
  const img = await loadImage(ocrDataURL);
  const worker = await getOcrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '8' });
  try {
    for (const w of targets.slice(0, OCR_RECHECK_MAX)) {
      const crop = cropWordDataURL(img, w.bbox);
      if (!crop) continue;
      try {
        const { data } = await worker.recognize(crop, {}, { text: true });
        const cand = (data.text || '').trim().replace(/\s+/g, '');
        const conf = Math.round(data.confidence || 0);
        if (cand && conf > w.confidence) { w.text = cand; w.confidence = conf; }
      } catch {}
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: OCR_PSM });
  }
}

async function ocrWords(dataURL, { recheck = true } = {}) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(dataURL, {}, { blocks: true, text: true });
  let words = extractAllWords(data);
  if (recheck) await recheckLowConfWords(words, dataURL);
  words = words.filter(w => w.confidence >= OCR_MIN_CONF);
  return { words };
}

// ── Double-polarité (recall) ────────────────────────────────────────────────────
function mergeWordsByPosition(a, b) {
  const kept = a.slice();
  for (const w of b) {
    const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const tol = Math.max(8, w.bbox.y1 - w.bbox.y0);
    const dup = kept.find(k => {
      const kx = (k.bbox.x0 + k.bbox.x1) / 2, ky = (k.bbox.y0 + k.bbox.y1) / 2;
      return Math.abs(kx - cx) < tol && Math.abs(ky - cy) < tol;
    });
    if (dup) { if (w.confidence > dup.confidence) { dup.text = w.text; dup.confidence = w.confidence; dup.bbox = w.bbox; } }
    else kept.push(w);
  }
  return kept;
}

async function ocrWordsRobust(rawDataURL, { upscale = OCR_UPSCALE, recheck = true } = {}) {
  const [preNorm, preInv] = await Promise.all([
    preprocessImageForOCR(rawDataURL, upscale, false),
    preprocessImageForOCR(rawDataURL, upscale, true),
  ]);
  const A = await ocrWords(preNorm, { recheck });
  const B = await ocrWords(preInv, { recheck });
  return { words: mergeWordsByPosition(A.words, B.words) };
}

async function ocrImageRobust(rawDataURL, opts) {
  const { words } = await ocrWordsRobust(rawDataURL, opts);
  return groupWordsIntoBubbles(words);
}

// ── Zoom auto par zone ──────────────────────────────────────────────────────────
const ZONE_PAD = 16, ZONE_TARGET = 1400, ZONE_MAX_UP = 10;

function bubbleBboxSource(bubble) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const w of bubble.words) {
    x0 = Math.min(x0, w.bbox.x0); y0 = Math.min(y0, w.bbox.y0);
    x1 = Math.max(x1, w.bbox.x1); y1 = Math.max(y1, w.bbox.y1);
  }
  const s = OCR_UPSCALE, m = OCR_MARGIN;
  return { x0: (x0 - m) / s, y0: (y0 - m) / s, x1: (x1 - m) / s, y1: (y1 - m) / s };
}

function cropImageRect(img, bb, pad) {
  const x = Math.max(0, Math.floor(bb.x0 - pad)), y = Math.max(0, Math.floor(bb.y0 - pad));
  const x1 = Math.min(img.naturalWidth, Math.ceil(bb.x1 + pad)), y1 = Math.min(img.naturalHeight, Math.ceil(bb.y1 + pad));
  const w = x1 - x, h = y1 - y;
  if (w <= 2 || h <= 2) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
  return { url: c.toDataURL('image/png'), w, h };
}

const avgConf = words => Math.round(words.reduce((s, w) => s + w.confidence, 0) / words.length);

async function ocrZonesZoomed(originalDataURL) {
  const zones = await ocrImageRobust(originalDataURL, { recheck: false });
  if (!zones.length) return [];
  const origImg = await loadImage(originalDataURL);
  const refined = [];
  for (let i = 0; i < zones.length; i++) {
    setStatus(`Zoom des zones de texte… (${i + 1}/${zones.length})`);
    const bb = bubbleBboxSource(zones[i]);
    const crop = cropImageRect(origImg, bb, ZONE_PAD);
    let words = null;
    if (crop) {
      const up = Math.min(ZONE_MAX_UP, Math.max(OCR_UPSCALE, Math.round(ZONE_TARGET / Math.max(crop.w, crop.h))));
      const r = await ocrWordsRobust(crop.url, { upscale: up, recheck: false }).catch(() => ({ words: [] }));
      if (r.words.length) words = r.words;
    }
    refined.push(words ? { confidence: avgConf(words), words, bbox: bb } : { ...zones[i], bbox: bb });
  }
  return refined;
}

// ── Filtres texte → bulles affichables ──────────────────────────────────────────
const cleanOcrText = t => (t || '').replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim();
const wordsToText = words => words.map(w => w.text).join(' ');
const filterLexical = t => (t || '').split(' ').filter(x => /[a-zA-Z]/.test(x) && !/[0-9]/.test(x)).join(' ');

const UI_STOPWORDS = new Set([
  'chapter', 'chapitre', 'chap', 'cap', 'episode', 'ep', 'volume', 'vol',
  'manga', 'mangas', 'manhwa', 'manhua', 'webtoon', 'webtoons', 'scan', 'scans',
  'prev', 'previous', 'next', 'home', 'menu', 'search', 'login', 'logout',
  'signin', 'signup', 'register', 'bookmark', 'bookmarks', 'comments', 'comment',
  'share', 'report', 'download', 'subscribe', 'advertisement', 'sponsored',
  'accueil', 'connexion', 'suivant', 'precedent', 'rechercher', 'telecharger',
]);
function isUiNoise(text) {
  const toks = (text || '').toLowerCase().split(/\s+/).map(t => t.replace(/[^a-zà-ÿ]/gi, '')).filter(Boolean);
  return !toks.length || toks.every(t => UI_STOPWORDS.has(t));
}

const LOW_CONF = 70, NOISE_CONF = 50, NOISE_MAX_LETTERS = 3;
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

// ── Traduction MyMemory (mode local) ────────────────────────────────────────────
// Pas d'e-mail codé en dur (vie privée + quota partagé). Vide ⇒ quota anonyme.
const MYMEMORY_EMAIL = '';
async function translateWithMyMemory(text) {
  const de = MYMEMORY_EMAIL ? `&de=${encodeURIComponent(MYMEMORY_EMAIL)}` : '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|fr${de}`;
  let resp;
  try { resp = await fetch(url); } catch { throw new Error('MyMemory : erreur réseau'); }
  if (!resp.ok) throw new Error(`MyMemory : HTTP ${resp.status}`);
  const data = await resp.json();
  const tr = data?.responseData?.translatedText;
  if (!tr) throw new Error('MyMemory : réponse vide');
  return tr;
}

// ── Mode IA (resize + bascule fournisseurs) ─────────────────────────────────────
function resizeForAI(dataURL, { minWidth = 1200, maxWidth = 1536, maxHeight = 14000, maxUpscale = 6, quality = 0.9 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let scale = img.width < minWidth ? Math.min(minWidth / img.width, maxUpscale) : 1;
      scale = Math.min(scale, maxWidth / img.width, maxHeight / img.height);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// Sur le web on masque les fournisseurs locaux (Ollama/LM Studio) : un téléphone ne
// peut pas joindre le localhost d'un PC (et HTTPS bloque le HTTP local).
const WEB_PROVIDER_IDS = Object.keys(AI_PROVIDERS).filter(id => !AI_PROVIDERS[id].noKey);

function aiChain() {
  return WEB_PROVIDER_IDS
    .filter(id => aiEnabled[id] && aiKeys[id])
    .map(id => ({ id, key: aiKeys[id], model: AI_PROVIDERS[id].model }));
}

async function analyzeWithAI(imageUrl) {
  setStatus('Optimisation de l\'image…');
  const b64 = (await resizeForAI(imageUrl)).split(',')[1];
  const chain = aiChain();
  if (!chain.length) throw aiError('Aucun fournisseur IA configuré. Ouvre ⚙️ Réglages.', 'NO_KEY');
  let lastErr;
  for (const p of chain) {
    try {
      setStatus(`Analyse IA — ${AI_PROVIDERS[p.id].label}…`);
      const blocks = await analyzeWithProvider(p.id, p.key, p.model, b64, 'image/jpeg');
      return blocks.map(b => ({ en: b.en, fr: b.fr, lang: b.lang }));
    } catch (err) {
      lastErr = err;
      console.warn(`[MT] ${p.id} a échoué (${err.code || '?'}) :`, err.message);
    }
  }
  throw lastErr || aiError('Tous les fournisseurs IA ont échoué.', 'ALL_FAILED');
}

// ── DOM + état ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const stateEmpty = $('stateEmpty'), stateProgress = $('stateProgress'), stateSuccess = $('stateSuccess'), stateError = $('stateError');
const progressText = $('progressText'), capturePreview = $('capturePreview'), blocksContainer = $('blocksContainer');
const blocksCount = $('blocksCount'), errorMessage = $('errorMessage');
const settingsPanel = $('settingsPanel'), modeLocal = $('modeLocal'), modeAi = $('modeAi');
const aiKeySection = $('aiKeySection'), aiProvidersList = $('aiProvidersList'), saveKeyMsg = $('saveKeyMsg');
const fileImport = $('fileImport'), fileCamera = $('fileCamera');

let translationMode = 'local';
let aiKeys = {}, aiEnabled = {};
let currentBlocks = [];
let _gen = 0;

const ALL_STATES = [stateEmpty, stateProgress, stateSuccess, stateError];
function showState(el) { ALL_STATES.forEach(s => s.classList.add('hidden')); el.classList.remove('hidden'); }
function setStatus(text) { progressText.textContent = text; showState(stateProgress); }
function showError(msg) { errorMessage.textContent = msg || 'Erreur inconnue.'; showState(stateError); }
const errMsg = err => (err instanceof Error ? err.message : String(err)) || 'Erreur inconnue';

// ── Réglages (localStorage) ─────────────────────────────────────────────────────
function lsGet(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function updateModeUI() {
  modeLocal.checked = translationMode === 'local';
  modeAi.checked = translationMode === 'ai';
  aiKeySection.classList.toggle('hidden', translationMode !== 'ai');
}

function buildProviderRows() {
  aiProvidersList.innerHTML = '';
  for (const id of WEB_PROVIDER_IDS) {
    const meta = AI_PROVIDERS[id];
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
        <button type="button" class="btn-toggle-key">👁</button>
      </div>
      <a class="settings-link" href="${meta.keyUrl}" target="_blank" rel="noopener">Obtenir une clé →</a>
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

function loadSettings() {
  translationMode = lsGet('translationMode', 'local') === 'ai' ? 'ai' : 'local';
  aiKeys = lsGet('aiKeys', {}); aiEnabled = lsGet('aiEnabled', {});
  buildProviderRows();
  updateModeUI();
}

function showSaveMsg(text, ok) {
  saveKeyMsg.textContent = text;
  saveKeyMsg.className = `save-key-msg ${ok ? 'save-key-ok' : 'save-key-err'}`;
  saveKeyMsg.classList.remove('hidden');
  setTimeout(() => saveKeyMsg.classList.add('hidden'), 3000);
}

function saveSettings() {
  const mode = modeAi.checked ? 'ai' : 'local';
  const keys = {}, enabled = {};
  aiProvidersList.querySelectorAll('.provider-row').forEach(row => {
    const id = row.querySelector('.provider-key').dataset.prov;
    keys[id] = row.querySelector('.provider-key').value.trim();
    enabled[id] = row.querySelector('.provider-toggle').checked;
  });
  if (mode === 'ai' && !WEB_PROVIDER_IDS.some(id => enabled[id] && keys[id])) {
    showSaveMsg('Active au moins un fournisseur IA avec une clé.', false);
    return;
  }
  translationMode = mode; aiKeys = keys; aiEnabled = enabled;
  lsSet('translationMode', mode); lsSet('aiKeys', keys); lsSet('aiEnabled', enabled);
  showSaveMsg('Réglages enregistrés !', true);
  setTimeout(() => settingsPanel.classList.add('hidden'), 800);
}

// ── Analyse depuis une image fournie ────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => startAnalysis(r.result);
  r.onerror = () => showError('Impossible de lire le fichier.');
  r.readAsDataURL(file);
}

async function startAnalysis(dataURL) {
  try {
    if (translationMode === 'ai') {
      const blocks = await analyzeWithAI(dataURL);
      renderCards(dataURL, blocks, false);
    } else {
      setStatus('Détection des zones de texte…');
      const regions = await ocrZonesZoomed(dataURL);
      renderCards(dataURL, regionsToBubbles(regions), true);
    }
  } catch (err) {
    console.error('[MT] Analyse :', err);
    showError(errMsg(err));
  }
}

// ── Rendu ───────────────────────────────────────────────────────────────────────
const confClass = c => c >= 75 ? 'conf-high' : c >= 50 ? 'conf-mid' : 'conf-low';
const escapeHtml = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderCards(previewUrl, items, isLocal) {
  const gen = ++_gen;
  capturePreview.src = previewUrl;
  currentBlocks = items.map(b => ({ en: b.en, fr: b.fr || '', lang: b.lang, confidence: b.confidence }));
  blocksContainer.innerHTML = '';

  if (!items.length) {
    blocksCount.textContent = 'Aucun texte détecté';
    blocksContainer.innerHTML = '<p class="no-text-msg">Aucun texte détecté.<br>Essaie une image plus nette ou recadrée.</p>';
    showState(stateSuccess);
    return;
  }
  const n = items.length;
  blocksCount.textContent = `${n} bulle${n > 1 ? 's' : ''}`;
  showState(stateSuccess);

  items.forEach((b, i) => {
    const card = createBlockCard(b, i);
    blocksContainer.appendChild(card);
    if (isLocal) {
      const frEl = card.querySelector('.block-fr-text');
      translateWithMyMemory(b.en)
        .then(fr => { if (gen !== _gen) return; currentBlocks[i].fr = fr; frEl.textContent = fr; })
        .catch(err => { if (gen !== _gen) return; frEl.textContent = errMsg(err); });
    }
  });
}

// Drapeau de la langue source. Mode local = OCR anglais seul ⇒ pas de `lang` ⇒ 🇬🇧.
// Mode IA = `lang` (code ISO 639-1) renvoyé par le modèle ⇒ drapeau correspondant.
const LANG_FLAGS = {
  en: '🇬🇧', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳', fr: '🇫🇷', es: '🇪🇸', de: '🇩🇪',
  it: '🇮🇹', pt: '🇵🇹', ru: '🇷🇺', nl: '🇳🇱', th: '🇹🇭', vi: '🇻🇳', ar: '🇸🇦',
};
function langToFlag(lang) {
  if (!lang) return '🇬🇧';
  return LANG_FLAGS[lang.slice(0, 2)] || '🌐';
}

function createBlockCard(block, index) {
  const card = document.createElement('div');
  card.className = 'block-card';
  card.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
  const hasConf = block.confidence != null;
  if (hasConf && block.confidence < LOW_CONF) card.classList.add('low-conf');
  const frText = block.fr ? escapeHtml(block.fr) : '<span class="block-pending">Traduction…</span>';
  card.innerHTML = `
    <div class="block-header">
      <span class="block-num">${index + 1}</span>
      ${hasConf ? `<span class="block-conf ${confClass(block.confidence)}">${block.confidence}%</span>` : ''}
    </div>
    <div class="block-lang block-fr">
      <span class="lang-flag">🇫🇷</span>
      <p class="block-lang-text block-fr-text">${frText}</p>
      <button class="btn-copy-block btn-copy-fr" title="Copier">⧉</button>
    </div>
    <div class="block-lang block-en">
      <span class="lang-flag">${langToFlag(block.lang)}</span>
      <p class="block-lang-text block-en-text">${escapeHtml(block.en)}</p>
      <button class="btn-copy-block btn-copy-en" title="Copier">⧉</button>
    </div>
  `;
  card.querySelector('.btn-copy-en').addEventListener('click', e => copyToClipboard(block.en, e.currentTarget));
  card.querySelector('.btn-copy-fr').addEventListener('click', e => copyToClipboard(currentBlocks[index]?.fr || '', e.currentTarget));
  return card;
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓'; btn.classList.add('btn-copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('btn-copied'); }, 1500);
  } catch (err) { console.error('[MT] Clipboard:', err); }
}

// ── Écouteurs ─────────────────────────────────────────────────────────────────
$('importBtn').addEventListener('click', () => fileImport.click());
$('cameraBtn').addEventListener('click', () => fileCamera.click());
fileImport.addEventListener('change', e => handleFile(e.target.files[0]));
fileCamera.addEventListener('change', e => handleFile(e.target.files[0]));

$('settingsBtn').addEventListener('click', () => settingsPanel.classList.remove('hidden'));
$('settingsCloseBtn').addEventListener('click', () => settingsPanel.classList.add('hidden'));
modeLocal.addEventListener('change', () => aiKeySection.classList.add('hidden'));
modeAi.addEventListener('change', () => aiKeySection.classList.remove('hidden'));
$('saveSettingsBtn').addEventListener('click', saveSettings);

$('copyAllBtn').addEventListener('click', e => {
  const all = currentBlocks.map(b => `🇫🇷 ${b.fr}\n${langToFlag(b.lang)} ${b.en}`).join('\n\n');
  copyToClipboard(all, e.currentTarget);
});
$('newCaptureBtn').addEventListener('click', () => { fileImport.value = ''; fileCamera.value = ''; showState(stateEmpty); });
$('retryBtn').addEventListener('click', () => showState(stateEmpty));

// ── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
showState(stateEmpty);
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
