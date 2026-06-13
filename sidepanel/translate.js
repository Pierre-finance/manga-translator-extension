const MT_CACHE_PREFIX = 'mt_';
const MT_CACHE_TTL    = 7 * 24 * 60 * 60 * 1000; // 7 jours
const MT_CACHE_MAX    = 200;
const MT_CHUNK_SIZE   = 450; // légèrement sous la limite API de 500
const MT_API          = 'https://api.mymemory.translated.net/get';

// ── Cache localStorage ────────────────────────────────────────────────────────

function _hash(str) {
  // djb2
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function getCached(text) {
  try {
    const raw = localStorage.getItem(MT_CACHE_PREFIX + _hash(text));
    if (!raw) return null;
    const { v, e } = JSON.parse(raw);
    if (Date.now() > e) {
      localStorage.removeItem(MT_CACHE_PREFIX + _hash(text));
      return null;
    }
    return v;
  } catch { return null; }
}

function setCached(text, translation) {
  try {
    _purgeCache();
    localStorage.setItem(
      MT_CACHE_PREFIX + _hash(text),
      JSON.stringify({ v: translation, e: Date.now() + MT_CACHE_TTL })
    );
  } catch { /* stockage plein, on ignore */ }
}

function clearCached(text) {
  try { localStorage.removeItem(MT_CACHE_PREFIX + _hash(text)); } catch { }
}

function _purgeCache() {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(MT_CACHE_PREFIX));
    if (keys.length < MT_CACHE_MAX) return;
    const now = Date.now();
    for (const k of keys) {
      try {
        if (JSON.parse(localStorage.getItem(k)).e < now) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    }
    const remaining = Object.keys(localStorage).filter(k => k.startsWith(MT_CACHE_PREFIX));
    if (remaining.length >= MT_CACHE_MAX) {
      // Supprime les plus anciennes (FIFO approximatif)
      remaining.slice(0, remaining.length - MT_CACHE_MAX + 20).forEach(k => localStorage.removeItem(k));
    }
  } catch { }
}

// ── Découpage en chunks ───────────────────────────────────────────────────────

function _splitChunks(text) {
  if (text.length <= MT_CHUNK_SIZE) return [text];
  const chunks = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= MT_CHUNK_SIZE) { chunks.push(rem); break; }
    let at = rem.lastIndexOf(' ', MT_CHUNK_SIZE);
    if (at <= 0) at = MT_CHUNK_SIZE;
    chunks.push(rem.slice(0, at));
    rem = rem.slice(at).trim();
  }
  return chunks;
}

// ── Appel API ─────────────────────────────────────────────────────────────────

async function _fetchChunk(chunk) {
  let resp;
  try {
    resp = await fetch(`${MT_API}?q=${encodeURIComponent(chunk)}&langpair=en|fr`);
  } catch {
    throw Object.assign(new Error('Réseau indisponible'), { code: 'NETWORK' });
  }
  if (!resp.ok) throw Object.assign(new Error('Erreur serveur MyMemory'), { code: 'NETWORK' });

  const data = await resp.json();
  const translated = data.responseData?.translatedText || '';

  if (
    data.responseStatus === 403 ||
    translated.toUpperCase().startsWith('MYMEMORY WARNING')
  ) {
    throw Object.assign(new Error('Quota MyMemory dépassé'), { code: 'QUOTA' });
  }
  return translated;
}

// ── API publique ──────────────────────────────────────────────────────────────

async function translateText(textEN) {
  const t = (textEN || '').trim();
  if (t.length < 2) return { text: t, fromCache: false };

  const cached = getCached(t);
  if (cached !== null) return { text: cached, fromCache: true };

  const chunks  = _splitChunks(t);
  const parts   = await Promise.all(chunks.map(_fetchChunk));
  const result  = parts.join(' ');

  setCached(t, result);
  return { text: result, fromCache: false };
}

// onProgress(done, total, blockIndex, { status:'fulfilled', value } | { status:'rejected', reason })
async function translateMultiple(blocks, onProgress) {
  let done = 0;
  return Promise.allSettled(
    blocks.map(async (block, i) => {
      try {
        const value = await translateText(block.text);
        onProgress?.(++done, blocks.length, i, { status: 'fulfilled', value });
        return value;
      } catch (err) {
        console.error(`[MT] Bloc ${i} erreur traduction:`, err);
        onProgress?.(++done, blocks.length, i, { status: 'rejected', reason: err });
        throw err;
      }
    })
  );
}
