const GEMINI_MODEL = 'gemini-2.5-flash-lite';

const GEMINI_PROMPT = `You are a manga translation assistant. Analyze this manga page or panel image.

Identify every speech bubble or text box containing English text, in natural reading order (top to bottom, right to left for manga panels, or left to right if the layout is western-style).

For each bubble:
- Read the English text exactly as written, using visual context to resolve any ambiguous characters (e.g., distinguish "I" from "l", "0" from "O", "STATS" from "STAYS").
- Produce a natural, fluent French translation — not word-for-word, but adapted to the tone and register of manga dialogue. Keep the energy: if the character is angry, surprised, or whispering, reflect that.
- For sound effects and onomatopoeia: if there is an obvious French equivalent, use it; otherwise keep the original with a parenthetical note, e.g. "BOUM (bruit d'impact)".

Respond ONLY with valid JSON, no markdown formatting, no explanation, strictly:
{"blocks":[{"en":"...","fr":"..."}]}

If no text is found in the image: {"blocks":[]}`;

async function getApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get('geminiApiKey', data => resolve(data.geminiApiKey || null));
  });
}

async function analyzeImage(base64Image, mimeType = 'image/png') {
  const key = await getApiKey();
  if (!key) {
    const err = new Error('Clé API Gemini non configurée. Ouvre les réglages (⚙️) pour la saisir.');
    err.code = 'NO_KEY';
    throw err;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Image } },
            { text: GEMINI_PROMPT }
          ]
        }],
        generationConfig: { temperature: 0.2 }
      })
    });
  } catch {
    const err = new Error('Erreur réseau — vérifie ta connexion internet.');
    err.code = 'NETWORK';
    throw err;
  }

  if (response.status === 401 || response.status === 403) {
    const err = new Error('Clé API invalide ou non autorisée. Vérifie la clé dans les réglages (⚙️).');
    err.code = 'INVALID_KEY';
    throw err;
  }
  if (response.status === 429) {
    let detail = '';
    try {
      const errData = await response.json();
      detail = errData?.error?.message || '';
    } catch { /* corps illisible */ }
    const msg = detail
      ? `Quota Gemini dépassé — ${detail}`
      : 'Quota Gemini dépassé. Réessaie dans quelques minutes.';
    console.error('[MT] 429 Gemini:', detail || '(pas de détail)');
    const err = new Error(msg);
    err.code = 'QUOTA';
    throw err;
  }
  if (response.status === 404) {
    const err = new Error(`Modèle "${GEMINI_MODEL}" introuvable — mets à jour la constante GEMINI_MODEL dans gemini.js.`);
    err.code = 'MODEL_NOT_FOUND';
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`Erreur Gemini (HTTP ${response.status}).`);
    err.code = 'HTTP_ERROR';
    throw err;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const err = new Error('Réponse Gemini illisible (JSON invalide).');
    err.code = 'PARSE_ERROR';
    throw err;
  }

  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) {
    const err = new Error('Réponse Gemini vide ou inattendue.');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }

  // Strip possible markdown code fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const err = new Error('La réponse de Gemini n\'est pas du JSON valide.');
    err.code = 'JSON_PARSE';
    throw err;
  }

  if (!Array.isArray(parsed?.blocks)) {
    const err = new Error('Format de réponse Gemini inattendu (pas de champ "blocks").');
    err.code = 'BAD_FORMAT';
    throw err;
  }

  return parsed.blocks;
}
