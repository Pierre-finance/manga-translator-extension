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

const capturePreview  = document.getElementById('capturePreview');
const blocksContainer = document.getElementById('blocksContainer');
const blocksCount     = document.getElementById('blocksCount');
const errorMessage    = document.getElementById('errorMessage');
const copyAllBtn      = document.getElementById('copyAllBtn');
const newCaptureBtn   = document.getElementById('newCaptureBtn');
const retryBtn        = document.getElementById('retryBtn');
const emptyHint       = document.getElementById('emptyHint');

// Settings
const settingsBtn      = document.getElementById('settingsBtn');
const settingsPanel    = document.getElementById('settingsPanel');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const apiKeyInput      = document.getElementById('apiKeyInput');
const toggleKeyBtn     = document.getElementById('toggleKeyBtn');
const saveKeyBtn       = document.getElementById('saveKeyBtn');
const saveKeyMsg       = document.getElementById('saveKeyMsg');

// ── State ─────────────────────────────────────────────────────────────────────
let currentBlocks   = [];
let capturedDataURL = null;
let selectorInstance = null;
let lastRequestTime  = 0;

const MIN_INTERVAL_MS = 6000;
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

// ── Settings panel ─────────────────────────────────────────────────────────────
function openSettings() { settingsPanel.classList.remove('hidden'); }
function closeSettings() { settingsPanel.classList.add('hidden'); }

async function loadSavedKey() {
  const key = await new Promise(r => chrome.storage.local.get('geminiApiKey', d => r(d.geminiApiKey || '')));
  if (key) apiKeyInput.value = key;
}

async function checkKeyAndUpdateEmptyState() {
  const key = await new Promise(r => chrome.storage.local.get('geminiApiKey', d => r(d.geminiApiKey || '')));
  if (!key) {
    emptyHint.innerHTML = 'Aucune clé API configurée.<br>Ouvre les <button class="btn-link" id="openSettingsFromHint">réglages ⚙️</button> pour en saisir une.';
    document.getElementById('openSettingsFromHint')?.addEventListener('click', openSettings);
  } else {
    emptyHint.textContent = 'Choisis un mode de capture ci-dessus.';
  }
}

settingsBtn.addEventListener('click', openSettings);
settingsCloseBtn.addEventListener('click', closeSettings);

toggleKeyBtn.addEventListener('click', () => {
  const isPass = apiKeyInput.type === 'password';
  apiKeyInput.type = isPass ? 'text' : 'password';
  toggleKeyBtn.textContent = isPass ? '🙈' : '👁';
});

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { showSaveMsg('Saisis une clé avant d\'enregistrer.', false); return; }
  await new Promise(r => chrome.storage.local.set({ geminiApiKey: key }, r));
  showSaveMsg('Clé enregistrée !', true);
  await checkKeyAndUpdateEmptyState();
});

function showSaveMsg(text, ok) {
  saveKeyMsg.textContent = text;
  saveKeyMsg.className = `save-key-msg ${ok ? 'save-key-ok' : 'save-key-err'}`;
  saveKeyMsg.classList.remove('hidden');
  setTimeout(() => saveKeyMsg.classList.add('hidden'), 3000);
}

// ── Guard : clé + throttle ────────────────────────────────────────────────────
async function checkKeyAndThrottle() {
  const hasKey = await new Promise(r =>
    chrome.storage.local.get('geminiApiKey', d => r(!!d.geminiApiKey))
  );
  if (!hasKey) {
    showError('Clé API Gemini non configurée. Ouvre les réglages (⚙️) pour la saisir.');
    openSettings();
    return false;
  }
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    const wait = Math.ceil((MIN_INTERVAL_MS - elapsed) / 1000);
    showError(`Patiente encore ${wait}s avant la prochaine analyse (limite gratuite Gemini).`);
    return false;
  }
  return true;
}

// ── Resize + appel Gemini (commun aux deux modes) ─────────────────────────────

// Redimensionne à maxWidth × maxHeight max, encode en JPEG pour réduire les tokens.
function resizeForGemini(dataURL, maxWidth = 1080, maxHeight = 14000, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scaleW = Math.min(1, maxWidth  / img.width);
      const scaleH = Math.min(1, maxHeight / img.height);
      const scale  = Math.min(scaleW, scaleH);
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      console.log(`[MT] Resize: ${img.width}×${img.height} → ${w}×${h} JPEG`);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

async function sendToGemini(imageUrl) {
  updateStatus('Optimisation de l\'image…');
  const resized = await resizeForGemini(imageUrl);
  const base64  = resized.split(',')[1];
  lastRequestTime = Date.now();
  updateStatus('Analyse par l\'IA…');
  return analyzeImage(base64, 'image/jpeg');
}

// ── Mode page entière ──────────────────────────────────────────────────────────
async function runFullPagePipeline() {
  if (!(await checkKeyAndThrottle())) return;

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

    let blocks = [];
    for (let i = 0; i < images.length; i++) {
      if (images.length > 1) updateStatus(`Analyse par l'IA… (segment ${i + 1}/${images.length})`);
      const seg = await sendToGemini(images[i]);
      blocks = blocks.concat(seg);
    }
    console.log('[MT] Gemini:', blocks.length, 'bloc(s)');
    renderResults(capturedDataURL, blocks);
  } catch (err) {
    console.error('[MT] Erreur page entière:', err);
    if (err.code === 'NO_KEY' || err.code === 'INVALID_KEY') {
      showError(errMsg(err));
      openSettings();
    } else {
      showError(errMsg(err));
    }
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
  if (!(await checkKeyAndThrottle())) return;

  setLoading(true);
  try {
    let imageUrl = capturedDataURL;
    if (selection) {
      updateStatus('Découpe de la zone…');
      imageUrl = await cropImage(capturedDataURL, selection);
    }
    const blocks = await sendToGemini(imageUrl);
    console.log('[MT] Gemini:', blocks.length, 'bloc(s)');
    renderResults(capturedDataURL, blocks);
  } catch (err) {
    console.error('[MT] Erreur analyse:', err);
    if (err.code === 'NO_KEY' || err.code === 'INVALID_KEY') {
      showError(errMsg(err));
      openSettings();
    } else {
      showError(errMsg(err));
    }
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

// ── Résultats ──────────────────────────────────────────────────────────────────
function renderResults(imageUrl, blocks) {
  capturePreview.src = imageUrl;
  currentBlocks = blocks;

  if (blocks.length === 0) {
    blocksCount.textContent = 'Aucun texte détecté';
    blocksContainer.innerHTML = '<p class="no-text-msg">Aucun texte détecté dans l\'image.<br>Essaie de sélectionner une bulle précise.</p>';
    showState(stateSuccess);
    return;
  }

  blocksContainer.innerHTML = '';
  blocks.forEach((block, i) => blocksContainer.appendChild(createBlockCard(block, i)));
  const n = blocks.length;
  blocksCount.textContent = `${n} bloc${n > 1 ? 's' : ''} traduit${n > 1 ? 's' : ''}`;
  showState(stateSuccess);
}

// ── Carte de bloc ──────────────────────────────────────────────────────────────
function createBlockCard(block, index) {
  const card = document.createElement('div');
  card.className = 'block-card';
  card.id = `block-card-${index}`;

  card.innerHTML = `
    <div class="block-header">
      <span class="block-num">#${index + 1}</span>
    </div>
    <div class="block-lang block-en">
      <span class="lang-flag">🇬🇧</span>
      <p class="block-lang-text block-en-text">${escapeHtml(block.en)}</p>
      <button class="btn-copy-block btn-copy-en">Copier EN</button>
    </div>
    <div class="block-lang block-fr">
      <span class="lang-flag">🇫🇷</span>
      <p class="block-lang-text block-fr-text">${escapeHtml(block.fr)}</p>
      <button class="btn-copy-block btn-copy-fr">Copier FR</button>
    </div>
  `;

  card.querySelector('.btn-copy-en').addEventListener('click', e => copyToClipboard(block.en, e.currentTarget));
  card.querySelector('.btn-copy-fr').addEventListener('click', e => copyToClipboard(block.fr, e.currentTarget));

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
loadSavedKey();
checkKeyAndUpdateEmptyState();
