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
let capturedDataURL  = null;  // conservé entre capture et OCR
let selectorInstance = null;

// ── UI helpers ────────────────────────────────────────────────────────────────

const ALL_STATES = [stateEmpty, stateProgress, stateSelect, stateSuccess, stateError];

function showState(el) {
  ALL_STATES.forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function setLoading(loading) {
  captureBtn.disabled = loading;
  if (loading) {
    btnIcon.textContent = '⏳';
    btnLabel.textContent = 'En cours…';
  } else {
    btnIcon.textContent = '📸';
    btnLabel.textContent = 'Capturer et traduire';
  }
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

// ── Tesseract worker (singleton, lazy init) ───────────────────────────────────

async function initWorker() {
  if (tesseractWorker) return;

  updateStatus('Chargement du moteur OCR…');

  // workerBlobURL:false est INDISPENSABLE en MV3 :
  // la valeur par défaut (true) crée un worker blob: d'origine null
  // qui ne peut pas accéder aux URLs chrome-extension://
  tesseractWorker = await Tesseract.createWorker('eng', 1, {
    workerPath:    chrome.runtime.getURL('lib/tesseract/worker.min.js'),
    corePath:      chrome.runtime.getURL('lib/tesseract/'),
    langPath:      chrome.runtime.getURL('lib/tesseract/lang/'),
    workerBlobURL: false,
    gzip:          true,
    logger: (m) => {
      console.log('[MT] Tesseract:', m.status, m.progress != null ? Math.round(m.progress * 100) + '%' : '');
      if (m.status === 'recognizing text') {
        updateStatus(`Analyse en cours… ${Math.round(m.progress * 100)}%`);
      } else if (m.status === 'loading tesseract core') {
        updateStatus('Chargement du moteur OCR…');
      } else if (m.status === 'loading language traineddata') {
        updateStatus('Chargement des données de langue…');
      } else if (m.status === 'initializing tesseract') {
        updateStatus('Initialisation…');
      }
    },
  });
}

// ── Étape 1 : Capture + affichage sélection ───────────────────────────────────

async function runPipeline() {
  setLoading(true);
  try {
    updateStatus('Capture en cours…');

    const captureResult = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Erreur de communication'));
        } else {
          resolve(response);
        }
      });
    });

    if (!captureResult) throw new Error('Aucune réponse du service worker. Recharge l\'extension.');
    if (!captureResult.success) throw new Error(captureResult.error);

    capturedDataURL = captureResult.dataURL;
    console.log('[MT] 1. Capture OK, longueur dataURL:', capturedDataURL.length);

    await showSelectState(capturedDataURL);

  } catch (err) {
    console.error('[MT] Erreur capture:', err);
    showError(errMsg(err));
  } finally {
    setLoading(false);
  }
}

async function showSelectState(dataURL) {
  // Afficher l'état avant de charger l'image pour que le container ait une taille
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

// ── Étape 2 : Crop + pré-traitement + OCR ────────────────────────────────────

async function runAnalysis(selection) {
  if (!capturedDataURL) { showState(stateEmpty); return; }

  setLoading(true);
  try {
    let imageUrl = capturedDataURL;

    // Découpe si sélection
    if (selection) {
      updateStatus('Découpe de la zone…');
      imageUrl = await cropImage(capturedDataURL, selection);
      console.log('[MT] 2. Crop OK:', selection);
    }

    // Pré-traitement
    let processedUrl = null;
    if (preprocessToggle.checked) {
      updateStatus('Préparation de l\'image…');
      imageUrl = await preprocessImage(imageUrl);
      processedUrl = imageUrl;
      console.log('[MT] 3. Pré-traitement OK');
    }

    // OCR
    await initWorker();
    console.log('[MT] 4. Worker prêt, lancement recognize()');
    updateStatus('Analyse en cours… 0%');
    const result = await tesseractWorker.recognize(imageUrl);
    console.log('[MT] 5. OCR terminé, blocs bruts:', result.data.blocks?.length);

    // Nettoyage
    updateStatus('Nettoyage du texte…');
    const blocks = result.data.blocks || [];
    const cleaned = cleanBlocks(blocks);
    console.log('[MT] 6. Blocs nettoyés:', cleaned.length);

    renderResults(capturedDataURL, cleaned, processedUrl);

  } catch (err) {
    console.error('[MT] Erreur analyse:', err);
    showError(errMsg(err));
    if (tesseractWorker) {
      tesseractWorker.terminate().catch(() => {});
      tesseractWorker = null;
    }
  } finally {
    setLoading(false);
  }
}

function cropImage(dataURL, { x, y, w, h }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

// ── Affichage des résultats ───────────────────────────────────────────────────

function renderResults(imageUrl, blocks, processedUrl = null) {
  capturePreview.src = imageUrl;
  currentBlocks = blocks;

  if (processedUrl) {
    preprocessPreview.src = processedUrl;
    preprocessPreviewWrap.classList.remove('hidden');
  } else {
    preprocessPreviewWrap.classList.add('hidden');
  }

  if (blocks.length === 0) {
    blocksCount.textContent = 'Aucun texte exploitable détecté';
    blocksContainer.innerHTML =
      '<p class="no-text-msg">Aucun texte exploitable détecté.<br>Zoome sur une bulle dans la page et recapture.</p>';
  } else {
    const n = blocks.length;
    blocksCount.textContent = `${n} bloc${n > 1 ? 's' : ''} extrait${n > 1 ? 's' : ''}`;
    blocksContainer.innerHTML = '';
    blocks.forEach((block, i) => blocksContainer.appendChild(createBlockCard(block, i + 1)));
  }

  showState(stateSuccess);
}

function badgeClass(confidence) {
  if (confidence >= 80) return 'badge-green';
  if (confidence >= 50) return 'badge-orange';
  return 'badge-red';
}

function createBlockCard(block, num) {
  const conf = Math.round(block.confidence ?? 0);
  const card = document.createElement('div');
  card.className = 'block-card';
  card.innerHTML = `
    <div class="block-header">
      <span class="block-num">#${num}</span>
      <span class="badge ${badgeClass(conf)}">${conf}%</span>
      <button class="btn-copy-block">Copier</button>
    </div>
    <p class="block-text">${escapeHtml(block.text)}</p>
  `;
  card.querySelector('.btn-copy-block').addEventListener('click', (e) => {
    copyToClipboard(block.text, e.currentTarget);
  });
  return card;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = '✓';
    btn.classList.add('btn-copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('btn-copied'); }, 1500);
  } catch (err) {
    console.error('[MT] Clipboard error:', err);
  }
}

// ── Écouteurs d'événements ────────────────────────────────────────────────────

captureBtn.addEventListener('click', runPipeline);

analyzeSelBtn.addEventListener('click', () => {
  const sel = selectorInstance?.getRealSelection();
  if (!sel) {
    console.log('[MT] Pas de sélection valide → analyse image complète');
  }
  runAnalysis(sel);
});

analyzeAllBtn.addEventListener('click', () => runAnalysis(null));

recaptureBtn.addEventListener('click', runPipeline);

copyAllBtn.addEventListener('click', (e) => {
  const all = currentBlocks.map((b) => b.text).join('\n\n');
  copyToClipboard(all, e.currentTarget);
});

newCaptureBtn.addEventListener('click', runPipeline);

retryBtn.addEventListener('click', () => {
  // Si on a une image capturée, retourner en mode sélection
  if (capturedDataURL) {
    showSelectState(capturedDataURL);
  } else {
    showState(stateEmpty);
  }
});

window.addEventListener('unload', () => {
  tesseractWorker?.terminate();
});
