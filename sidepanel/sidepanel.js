// ── DOM refs ──────────────────────────────────────────────────────────────────
const captureBtn          = document.getElementById('captureBtn');
const btnLabel            = captureBtn.querySelector('.btn-label');
const btnIcon             = captureBtn.querySelector('.btn-icon');
const preprocessToggle    = document.getElementById('preprocessToggle');

const stateEmpty          = document.getElementById('stateEmpty');
const stateProgress       = document.getElementById('stateProgress');
const stateSelect         = document.getElementById('stateSelect');
const stateSuccess        = document.getElementById('stateSuccess');
const stateError          = document.getElementById('stateError');

const progressText        = document.getElementById('progressText');
const selectCanvas        = document.getElementById('selectCanvas');
const analyzeSelBtn       = document.getElementById('analyzeSelBtn');
const analyzeAllBtn       = document.getElementById('analyzeAllBtn');
const recaptureBtn        = document.getElementById('recaptureBtn');

const qualityWarn         = document.getElementById('qualityWarn');
const capturePreview      = document.getElementById('capturePreview');
const preprocessPreview   = document.getElementById('preprocessPreview');
const preprocessPreviewWrap = document.getElementById('preprocessPreviewWrap');
const blocksContainer     = document.getElementById('blocksContainer');
const blocksCount         = document.getElementById('blocksCount');
const errorMessage        = document.getElementById('errorMessage');
const copyAllBtn          = document.getElementById('copyAllBtn');
const newCaptureBtn       = document.getElementById('newCaptureBtn');
const retryBtn            = document.getElementById('retryBtn');

// ── État global ───────────────────────────────────────────────────────────────
let tesseractWorker  = null;
let currentBlocks    = [];
let capturedDataURL  = null;
let selectorInstance = null;

const ALL_STATES = [stateEmpty, stateProgress, stateSelect, stateSuccess, stateError];

// ── UI helpers ────────────────────────────────────────────────────────────────

function showState(el) {
  ALL_STATES.forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function setLoading(loading) {
  captureBtn.disabled = loading;
  btnIcon.textContent  = loading ? '⏳' : '📸';
  btnLabel.textContent = loading ? 'En cours…' : 'Capturer et traduire';
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

// ── Tesseract worker (singleton) ──────────────────────────────────────────────

async function initWorker() {
  if (tesseractWorker) return;
  updateStatus('Chargement du moteur OCR…');
  tesseractWorker = await Tesseract.createWorker('eng', 1, {
    workerPath:    chrome.runtime.getURL('lib/tesseract/worker.min.js'),
    corePath:      chrome.runtime.getURL('lib/tesseract/'),
    langPath:      chrome.runtime.getURL('lib/tesseract/lang/'),
    workerBlobURL: false,
    gzip:          true,
    logger: (m) => {
      console.log('[MT] Tesseract:', m.status, m.progress != null ? Math.round(m.progress * 100) + '%' : '');
      if (m.status === 'recognizing text')          updateStatus(`Analyse en cours… ${Math.round(m.progress * 100)}%`);
      else if (m.status === 'loading tesseract core')      updateStatus('Chargement du moteur OCR…');
      else if (m.status === 'loading language traineddata') updateStatus('Chargement des données de langue…');
      else if (m.status === 'initializing tesseract')       updateStatus('Initialisation…');
    },
  });
}

// ── PSM dynamique ─────────────────────────────────────────────────────────────

// PSM 7 = ligne unique (sélection très large/basse), PSM 6 = bloc uniforme
function choosePsm(selection) {
  if (!selection) return 6;
  return (selection.w / (selection.h || 1)) > 4 ? 7 : 6;
}

// ── OCR avec re-zoom automatique ──────────────────────────────────────────────

async function recognizeWithRetry(imageUrl, selection) {
  const psm = choosePsm(selection);
  await tesseractWorker.setParameters({
    tessedit_pageseg_mode: String(psm),
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });

  updateStatus('Analyse en cours… 0%');
  const pass1 = await tesseractWorker.recognize(imageUrl);
  const conf1  = pass1.data.confidence ?? 0;
  const words  = (pass1.data.words || []).filter(w => w.text.trim().length > 0);
  const ratio1 = unknownWordRatio(words.map(w => w.text).join(' '));
  console.log(`[MT] Passe 1: conf ${Math.round(conf1)}%, inconnus: ${Math.round(ratio1 * 100)}%, mots: ${words.length}`);

  // Retry si confiance faible OU trop de mots non reconnus par le dictionnaire
  if (conf1 >= 60 && ratio1 < 0.35) return { result: pass1, retried: false };

  if (words.length < 2) {
    console.log('[MT] Pas assez de mots pour le re-zoom');
    return { result: pass1, retried: false };
  }

  const x0 = Math.min(...words.map(w => w.bbox.x0));
  const y0 = Math.min(...words.map(w => w.bbox.y0));
  const x1 = Math.max(...words.map(w => w.bbox.x1));
  const y1 = Math.max(...words.map(w => w.bbox.y1));
  const mX = Math.max(8, Math.round((x1 - x0) * 0.08));
  const mY = Math.max(8, Math.round((y1 - y0) * 0.08));

  updateStatus('Re-zoom automatique…');
  const zoomed = await cropAndUpscale(imageUrl, {
    x: x0 - mX, y: y0 - mY,
    w: (x1 - x0) + 2 * mX,
    h: (y1 - y0) + 2 * mY,
  }, 3);

  updateStatus('Re-zoom… 0%');
  const pass2 = await tesseractWorker.recognize(zoomed);
  const conf2 = pass2.data.confidence ?? 0;
  console.log(`[MT] Passe 2 (re-zoom): conf ${Math.round(conf2)}%, mots: ${pass2.data.words?.length ?? 0}`);

  if (conf2 > conf1) {
    console.log('[MT] Re-zoom retenu');
    return { result: pass2, retried: true };
  }
  console.log('[MT] Re-zoom n\'améliore pas, passe 1 retenue');
  return { result: pass1, retried: false };
}

// ── Étape 1 : Capture ────────────────────────────────────────────────────────

async function runPipeline() {
  setLoading(true);
  try {
    updateStatus('Capture en cours…');
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (response) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
    if (!result)          throw new Error('Aucune réponse. Recharge l\'extension.');
    if (!result.success)  throw new Error(result.error);

    capturedDataURL = result.dataURL;
    console.log('[MT] 1. Capture OK');
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

// ── Étape 2 : Analyse (crop + OCR) ───────────────────────────────────────────

async function runAnalysis(selection) {
  if (!capturedDataURL) { showState(stateEmpty); return; }
  setLoading(true);
  try {
    let imageUrl = capturedDataURL;

    if (selection) {
      updateStatus('Découpe de la zone…');
      imageUrl = await cropImage(capturedDataURL, selection);
      console.log('[MT] 2. Crop OK:', selection);
    }

    let processedUrl = null;
    if (preprocessToggle.checked) {
      updateStatus('Préparation de l\'image…');
      imageUrl = await preprocessImage(imageUrl);
      processedUrl = imageUrl;
      console.log('[MT] 3. Pré-traitement OK');
    } else {
      // Même sans pré-traitement complet : inversion auto si fond sombre
      const invRes = await autoInvertIfNeeded(imageUrl);
      if (invRes.inverted) {
        imageUrl = invRes.url;
        processedUrl = invRes.url;
        console.log('[MT] 3. Auto-inversion (fond sombre, pré-traitement désactivé)');
      }
    }

    await initWorker();
    console.log('[MT] 4. Worker prêt');
    const { result: ocrResult, retried } = await recognizeWithRetry(imageUrl, selection);
    const overallConf = ocrResult.data.confidence ?? 0;
    console.log(`[MT] 5. OCR terminé, blocs bruts: ${ocrResult.data.blocks?.length} — conf: ${Math.round(overallConf)}%${retried ? ' (re-zoom)' : ''}`);

    updateStatus('Nettoyage du texte…');
    const fixedBlocks     = fixBlockSpacing(ocrResult.data.blocks || []);
    const correctedBlocks = dictCorrectBlocks(fixedBlocks);
    const cleaned         = cleanBlocks(correctedBlocks);
    console.log('[MT] 6. Blocs nettoyés:', cleaned.length);

    renderResults(capturedDataURL, cleaned, processedUrl, overallConf, retried);

  } catch (err) {
    console.error('[MT] Erreur analyse:', err);
    showError(errMsg(err));
    if (tesseractWorker) { tesseractWorker.terminate().catch(() => {}); tesseractWorker = null; }
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

// ── Affichage des résultats ───────────────────────────────────────────────────

function renderResults(imageUrl, blocks, processedUrl = null, confidence = 100, retried = false) {
  capturePreview.src = imageUrl;
  currentBlocks = blocks;

  preprocessPreviewWrap.classList.toggle('hidden', !processedUrl);
  if (processedUrl) preprocessPreview.src = processedUrl;

  // Indicateur re-zoom / avertissement confiance
  const conf = Math.round(confidence);
  if (retried) {
    qualityWarn.textContent = confidence >= 60
      ? `✓ Recadrage auto appliqué (conf. ${conf}%)`
      : `✓ Recadrage auto appliqué — conf. encore faible (${conf}%), zoome davantage si besoin`;
    qualityWarn.className = 'quality-warn quality-info';
    qualityWarn.classList.remove('hidden');
  } else if (confidence < 60 && blocks.length > 0) {
    qualityWarn.textContent = `⚠ Texte incertain (conf. ${conf}%) — zoome sur la bulle et recapture.`;
    qualityWarn.className = 'quality-warn';
    qualityWarn.classList.remove('hidden');
  } else {
    qualityWarn.className = 'quality-warn hidden';
  }

  if (blocks.length === 0) {
    blocksCount.textContent = 'Aucun texte exploitable détecté';
    blocksContainer.innerHTML =
      '<p class="no-text-msg">Aucun texte exploitable détecté.<br>Zoome sur une bulle dans la page et recapture.</p>';
    showState(stateSuccess);
    return;
  }

  // Affichage immédiat des blocs EN, FR en attente
  blocksContainer.innerHTML = '';
  blocks.forEach((block, i) => blocksContainer.appendChild(createBlockCard(block, i)));
  setBlocksCountLabel(blocks.length, 0);
  showState(stateSuccess);

  // Traduction progressive (ne bloque pas l'UI)
  translateBlocks(blocks);
}

// ── Traduction progressive ────────────────────────────────────────────────────

async function translateBlocks(blocks) {
  console.log('[MT] 7. Lancement traduction pour', blocks.length, 'bloc(s)');
  let done = 0;

  await translateMultiple(blocks, (d, total, blockIndex, result) => {
    done = d;
    setBlocksCountLabel(total, done);
    applyTranslation(blockIndex, result);
    console.log(`[MT] Bloc ${blockIndex} traduit (fromCache: ${result.value?.fromCache})`);
  });

  setBlocksCountLabel(blocks.length, blocks.length, true);
  console.log('[MT] 8. Traduction terminée');
}

function setBlocksCountLabel(total, done, complete = false) {
  const n = total;
  const base = `${n} bloc${n > 1 ? 's' : ''}`;
  if (complete || done >= total) {
    blocksCount.textContent = `${base} traduit${n > 1 ? 's' : ''}`;
  } else {
    blocksCount.textContent = `${base} — Traduction… (${done}/${total})`;
  }
}

// Ratio de mots de `en` (longueur > 2) présents verbatim dans `fr`.
function _wordOverlap(fr, en) {
  const frSet  = new Set(fr.split(/\s+/).filter(w => w.length > 2));
  const enToks = en.split(/\s+/).filter(w => w.length > 2);
  if (enToks.length === 0) return 0;
  return enToks.filter(w => frSet.has(w)).length / enToks.length;
}

function applyTranslation(index, result) {
  const card   = document.getElementById(`block-card-${index}`);
  if (!card) return;
  const frText = card.querySelector('.block-fr-text');
  const frCopy = card.querySelector('.btn-copy-fr');

  if (result.status === 'fulfilled') {
    const translation = result.value.text;
    const original    = (currentBlocks[index]?.text || '').trim().toLowerCase();
    const translated  = translation.trim().toLowerCase();

    // Détection traduction échouée : FR quasi identique au EN
    const isCopy = original.length > 10 && translated === original;
    const isNearCopy = !isCopy && original.length > 10 && _wordOverlap(translated, original) > 0.75;

    if (isCopy || isNearCopy) {
      frText.textContent = 'Traduction douteuse — texte peut contenir des erreurs OCR';
      frText.classList.remove('translating');
      frText.classList.add('translate-error');
      frCopy.disabled = true;
    } else {
      frText.textContent = translation;
      frText.classList.remove('translating', 'translate-error');
      if (result.value.fromCache) frText.title = '⚡ Depuis le cache';
      frCopy.disabled = false;
    }
  } else {
    const code = result.reason?.code;
    frText.textContent = code === 'QUOTA'
      ? 'Quota gratuit dépassé, réessaie plus tard'
      : code === 'UNSEGMENTED'
      ? 'Mots collés — recapture en zoomant dans le navigateur'
      : 'Traduction indisponible';
    frText.classList.remove('translating');
    frText.classList.add('translate-error');
    frCopy.disabled = true;
  }
}

// ── Carte de bloc ─────────────────────────────────────────────────────────────

function createBlockCard(block, index) {
  const conf = Math.round(block.confidence ?? 0);
  const card = document.createElement('div');
  card.className = 'block-card';
  card.id = `block-card-${index}`;

  card.innerHTML = `
    <div class="block-header">
      <span class="block-num">#${index + 1}</span>
      <span class="badge ${badgeClass(conf)}">${conf}%</span>
      <button class="btn-retranslate" title="Retraduire">↻</button>
    </div>
    <div class="block-lang block-en">
      <span class="lang-flag">🇬🇧</span>
      <p class="block-lang-text block-en-text">${escapeHtml(block.text)}</p>
      <button class="btn-copy-block btn-copy-en">Copier EN</button>
    </div>
    <div class="block-lang block-fr">
      <span class="lang-flag">🇫🇷</span>
      <p class="block-lang-text block-fr-text translating">Traduction…</p>
      <button class="btn-copy-block btn-copy-fr" disabled>Copier FR</button>
    </div>
  `;

  card.querySelector('.btn-copy-en').addEventListener('click', (e) => {
    copyToClipboard(block.text, e.currentTarget);
  });
  card.querySelector('.btn-copy-fr').addEventListener('click', (e) => {
    copyToClipboard(card.querySelector('.block-fr-text').textContent, e.currentTarget);
  });
  card.querySelector('.btn-retranslate').addEventListener('click', () => {
    retranslateBlock(index, block.text);
  });

  return card;
}

async function retranslateBlock(index, textEN) {
  clearCached(textEN);
  const card   = document.getElementById(`block-card-${index}`);
  if (!card) return;
  const frText = card.querySelector('.block-fr-text');
  const frCopy = card.querySelector('.btn-copy-fr');

  frText.textContent = 'Traduction…';
  frText.className   = 'block-lang-text block-fr-text translating';
  frCopy.disabled    = true;

  try {
    const result = await translateText(textEN);
    frText.textContent = result.text;
    frText.className   = 'block-lang-text block-fr-text';
    frCopy.disabled    = false;
  } catch (err) {
    frText.textContent = err?.code === 'QUOTA'
      ? 'Quota gratuit dépassé, réessaie plus tard'
      : 'Traduction indisponible';
    frText.className = 'block-lang-text block-fr-text translate-error';
  }
}

function badgeClass(c) {
  return c >= 80 ? 'badge-green' : c >= 50 ? 'badge-orange' : 'badge-red';
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('btn-copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('btn-copied'); }, 1500);
  } catch (err) { console.error('[MT] Clipboard:', err); }
}

// ── Écouteurs ─────────────────────────────────────────────────────────────────

captureBtn.addEventListener('click', runPipeline);

analyzeSelBtn.addEventListener('click', () => {
  const sel = selectorInstance?.getRealSelection();
  if (!sel) console.log('[MT] Pas de sélection → image complète');
  runAnalysis(sel);
});

analyzeAllBtn.addEventListener('click', () => runAnalysis(null));
recaptureBtn.addEventListener('click', runPipeline);

copyAllBtn.addEventListener('click', (e) => {
  const all = currentBlocks.map((b, i) => {
    const card = document.getElementById(`block-card-${i}`);
    const fr   = card?.querySelector('.block-fr-text')?.textContent ?? '';
    const frOk = !fr.includes('Traduction') && !fr.includes('Quota') && fr.length > 0;
    return `🇬🇧 ${b.text}\n🇫🇷 ${frOk ? fr : '(non disponible)'}`;
  }).join('\n\n');
  copyToClipboard(all, e.currentTarget);
});

newCaptureBtn.addEventListener('click', runPipeline);

retryBtn.addEventListener('click', () => {
  if (capturedDataURL) showSelectState(capturedDataURL);
  else showState(stateEmpty);
});

window.addEventListener('unload', () => { tesseractWorker?.terminate(); });
