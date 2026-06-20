const sleep = ms => new Promise(r => setTimeout(r, ms));

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime  = header.match(/:(.*?);/)[1];
  const bytes = atob(b64);
  const buf   = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function base64FromBlob(blob) {
  const ab    = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary  = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ── Capture page entière ───────────────────────────────────────────────────────

// Retourne { dataURL, captureCount } ou lève une Error.
async function captureFullPage(tab) {
  const { id: tabId, windowId } = tab;

  // 1. Masquer les éléments fixed/sticky + lire les dimensions de la page
  let pageInfo;
  [{ result: pageInfo }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      document.querySelectorAll('*').forEach(el => {
        const pos = window.getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') {
          el.dataset.mtFixed = el.style.display || '';
          el.style.setProperty('display', 'none', 'important');
        }
      });
      return {
        scrollHeight:     Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
        viewportHeight:   window.innerHeight,
        viewportWidth:    window.innerWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
        originalScrollY:  Math.round(window.scrollY),
      };
    },
  });

  const { scrollHeight, viewportHeight, viewportWidth, originalScrollY } = pageInfo;

  // 2. Calculer les positions de scroll (chevauchement 60px pour éviter de couper du texte)
  const overlap   = 60;
  const positions = [];
  let y = 0;
  while (y < scrollHeight) {
    positions.push(y);
    if (y + viewportHeight >= scrollHeight) break;
    y += viewportHeight - overlap;
  }
  const total = positions.length;

  // 3. Défiler + capturer à chaque palier
  const captures   = [];
  let captureError = null;

  try {
    for (let i = 0; i < total; i++) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: py => window.scrollTo(0, py),
        args:  [positions[i]],
      });

      await sleep(700); // lazy-loading + rendu

      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
      captures.push({ dataUrl, scrollY: positions[i] });

      try { chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', step: i + 1, total }); } catch {}

      await sleep(250); // buffer limite Chrome (~2 cap/sec)
    }
  } catch (err) {
    captureError = err;
  } finally {
    // Restaurer la page quoi qu'il arrive
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: origY => {
          document.querySelectorAll('[data-mt-fixed]').forEach(el => {
            el.style.display = el.dataset.mtFixed;
            delete el.dataset.mtFixed;
          });
          window.scrollTo(0, origY);
        },
        args: [originalScrollY],
      });
    } catch {}
  }

  if (captureError) throw new Error(`Capture interrompue : ${captureError.message}`);

  // 4. Assemblage — scale calculé EN PREMIER, canvas directement aux dimensions finales
  try {
    const CHUNK_MAX = 12000;
    const scale     = Math.min(1, 1200 / viewportWidth);
    const finalW    = Math.round(viewportWidth  * scale);
    const finalH    = Math.round(scrollHeight   * scale);
    const scaledVH  = Math.round(viewportHeight * scale);

    const numChunks = Math.ceil(finalH / CHUNK_MAX);
    const images    = [];

    for (let k = 0; k < numChunks; k++) {
      const chunkY0 = k * CHUNK_MAX;
      const chunkY1 = Math.min((k + 1) * CHUNK_MAX, finalH);
      const chunkH  = chunkY1 - chunkY0;
      const logY0   = chunkY0 / scale;   // bornes en px logiques pour filtrer les paliers
      const logY1   = chunkY1 / scale;

      const cvs = new OffscreenCanvas(finalW, chunkH);
      const ctx  = cvs.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, finalW, chunkH);

      for (const { dataUrl, scrollY } of captures) {
        if (scrollY + viewportHeight <= logY0 || scrollY >= logY1) continue;
        const blob   = dataUrlToBlob(dataUrl);
        const bitmap = await createImageBitmap(blob);
        ctx.drawImage(bitmap, 0, Math.round(scrollY * scale) - chunkY0, finalW, scaledVH);
        bitmap.close();
      }

      const blob = await cvs.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
      images.push(`data:image/jpeg;base64,${await base64FromBlob(blob)}`);
    }

    const label = numChunks > 1 ? `${numChunks} segments` : '1 image';
    console.log(`[MT] Page entière: ${captures.length} paliers → ${finalW}×${finalH}px (${label})`);
    return { images, captureCount: captures.length };

  } catch (err) {
    throw new Error(`Assemblage échoué : ${err.message}`);
  }
}

// ── Initialisation ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ── Messages ───────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === 'CAPTURE_TAB') {
    (async () => {
      try {
        const dataURL = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        sendResponse({ ok: true, data: { dataURL } });
      } catch (err) {
        const isProtected =
          err.message.includes('chrome://') ||
          err.message.includes('Cannot access') ||
          err.message.includes('chrome-extension://');
        sendResponse({
          ok: false,
          error: isProtected
            ? 'Impossible de capturer cette page (page système ou protégée). Ouvre un site web normal et réessaie.'
            : `Erreur lors de la capture : ${err.message}`,
        });
      }
    })();
    return true;
  }

  if (message.type === 'CAPTURE_FULL_PAGE') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) throw new Error('Aucun onglet actif trouvé.');
        const data = await captureFullPage(tab);
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});
