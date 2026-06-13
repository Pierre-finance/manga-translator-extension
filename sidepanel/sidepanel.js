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
    }

    await initWorker();
    console.log('[MT] 4. Worker prêt');
    updateStatus('Analyse en cours… 0%');
    const ocrResult = await tesseractWorker.recognize(imageUrl);
    console.log('[MT] 5. OCR terminé, blocs bruts:', ocrResult.data.blocks?.length);

    updateStatus('Nettoyage du texte…');
    const cleaned = cleanBlocks(ocrResult.data.blocks || []);
    console.log('[MT] 6. Blocs nettoyés:', cleaned.length);

    renderResults(capturedDataURL, cleaned, processedUrl);

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

function renderResults(imageUrl, blocks, processedUrl = null) {
  capturePreview.src = imageUrl;
  currentBlocks = blocks;

  preprocessPreviewWrap.classList.toggle('hidden', !processedUrl);
  if (processedUrl) preprocessPreview.src = processedUrl;

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

function applyTranslation(index, result) {
  const card   = document.getElementById(`block-card-${index}`);
  if (!card) return;
  const frText = card.querySelector('.block-fr-text');
  const frCopy = card.querySelector('.btn-copy-fr');

  if (result.status === 'fulfilled') {
    frText.textContent = result.value.text;
    frText.classList.remove('translating', 'translate-error');
    if (result.value.fromCache) frText.title = '⚡ Depuis le cache';
    frCopy.disabled = false;
  } else {
    const code = result.reason?.code;
    frText.textContent = code === 'QUOTA'
      ? 'Quota gratuit dépassé, réessaie plus tard'
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
