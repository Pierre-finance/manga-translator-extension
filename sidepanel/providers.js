// ── Fournisseurs d'IA (vision OCR + traduction *→FR, source surtout EN), BYOK ────
// Interface commune : analyzeWithProvider(id, key, model, base64, mimeType) → [{en, fr}]
// Chaque fournisseur reçoit l'image + le même prompt et doit renvoyer {blocks:[{en,fr}]}.
// MV3 + host_permissions <all_urls> ⇒ pas de blocage CORS ; il faut juste lister chaque
// domaine dans le CSP connect-src (manifest.json).

const AI_PROMPT = `You are a manga translation assistant. Analyze this manga page or panel image.

Identify every speech bubble or text box containing text, in natural reading order (top to bottom, right to left for manga panels, or left to right if the layout is western-style). The text is usually English, but other languages (Japanese, Korean, etc.) may also appear — handle them all.

For each bubble:
- Read the source text exactly as written, in whatever language it is, using visual context to resolve ambiguous characters (e.g., distinguish "I" from "l", "0" from "O", "STATS" from "STAYS").
- ALWAYS produce a natural, fluent French translation, whatever the source language — adapted to the tone and register of manga dialogue, not word-for-word.
- For sound effects and onomatopoeia: use an obvious French equivalent if one exists; otherwise keep the original with a parenthetical note, e.g. "BOUM (bruit d'impact)".

Respond ONLY with valid JSON, no markdown formatting, no explanation, strictly. The "en" field holds the source text as written (even if not English), the "fr" field holds the French translation, and the "lang" field holds the ISO 639-1 code of the source language (e.g. "en", "ja", "ko", "zh", "es", "de"):
{"blocks":[{"en":"...","fr":"...","lang":"en"}]}

If no text is found in the image: {"blocks":[]}`;

// Métadonnées par fournisseur. L'ordre des clés = ordre de bascule par défaut
// (gratuits d'abord, payants ensuite). `kind` choisit le format de requête :
//   'gemini' | 'anthropic' | 'openai' (compatible OpenAI : OpenAI, Mistral, Groq,
//   OpenRouter, Together, SambaNova, DeepInfra, Hyperbolic, Fireworks, xAI…).
// Pour 'openai', `endpoint` est l'URL de l'API (chat completions).
// Les `model` sont des valeurs par défaut éditables — certains IDs (surtout les
// modèles vision open-source) évoluent ; si l'un renvoie « modèle introuvable »,
// changer la chaîne ici ou viser un autre fournisseur.
const AI_PROVIDERS = {
  // ── Gratuits / palier gratuit ──
  gemini: {
    kind: 'gemini', label: 'Gemini (Google)', model: 'gemini-2.5-flash-lite',
    keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…', note: 'Gratuit (quota limité)',
  },
  groq: {
    kind: 'openai', endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    label: 'Groq (Llama vision)', model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    keyUrl: 'https://console.groq.com/keys', keyHint: 'gsk_…', note: 'Gratuit, rapide',
  },
  mistral: {
    kind: 'openai', endpoint: 'https://api.mistral.ai/v1/chat/completions',
    label: 'Mistral (Pixtral)', model: 'pixtral-12b-2409',
    keyUrl: 'https://console.mistral.ai/api-keys', keyHint: '…', note: 'Palier gratuit (Europe)',
  },
  openrouter: {
    kind: 'openai', endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    label: 'OpenRouter (multi-modèles)', model: 'meta-llama/llama-3.2-11b-vision-instruct:free',
    keyUrl: 'https://openrouter.ai/keys', keyHint: 'sk-or-…', note: 'Routeur : 1 clé → des centaines de modèles',
  },
  together: {
    kind: 'openai', endpoint: 'https://api.together.xyz/v1/chat/completions',
    label: 'Together AI', model: 'meta-llama/Llama-Vision-Free',
    keyUrl: 'https://api.together.xyz/settings/api-keys', keyHint: '…', note: 'Palier gratuit (Llama vision)',
  },
  sambanova: {
    kind: 'openai', endpoint: 'https://api.sambanova.ai/v1/chat/completions',
    label: 'SambaNova', model: 'Llama-3.2-11B-Vision-Instruct',
    keyUrl: 'https://cloud.sambanova.ai/apis', keyHint: '…', note: 'Palier gratuit, rapide',
  },
  github: {
    kind: 'openai', endpoint: 'https://models.github.ai/inference/chat/completions',
    label: 'GitHub Models', model: 'openai/gpt-4o-mini',
    keyUrl: 'https://github.com/settings/tokens', keyHint: 'github_pat_… / ghp_…', note: 'Gratuit (dev, token GitHub)',
  },
  cohere: {
    kind: 'openai', endpoint: 'https://api.cohere.ai/compatibility/v1/chat/completions',
    label: 'Cohere (Aya Vision)', model: 'c4ai-aya-vision-8b',
    keyUrl: 'https://dashboard.cohere.com/api-keys', keyHint: '…', note: 'Clé d\'essai gratuite',
  },
  // ── Local (illimité, privé, 0 €) — nécessite un serveur lancé sur ta machine ──
  ollama: {
    kind: 'openai', endpoint: 'http://localhost:11434/v1/chat/completions', noKey: true,
    label: 'Ollama (local)', model: 'llama3.2-vision',
    keyUrl: 'https://ollama.com/download', keyHint: '(aucune clé)', note: 'Local — illimité, privé, 0 €',
  },
  lmstudio: {
    kind: 'openai', endpoint: 'http://localhost:1234/v1/chat/completions', noKey: true,
    label: 'LM Studio (local)', model: 'local-model',
    keyUrl: 'https://lmstudio.ai', keyHint: '(aucune clé)', note: 'Local — illimité, privé, 0 €',
  },
  // ── Crédits offerts puis payant ──
  nebius: {
    kind: 'openai', endpoint: 'https://api.studio.nebius.com/v1/chat/completions',
    label: 'Nebius AI Studio', model: 'Qwen/Qwen2-VL-72B-Instruct',
    keyUrl: 'https://studio.nebius.com/settings/api-keys', keyHint: '…', note: 'Crédits offerts puis payant',
  },
  novita: {
    kind: 'openai', endpoint: 'https://api.novita.ai/v3/openai/chat/completions',
    label: 'Novita AI', model: 'meta-llama/llama-3.2-11b-vision-instruct',
    keyUrl: 'https://novita.ai/settings/key-management', keyHint: '…', note: 'Crédits offerts puis payant',
  },
  // ── Payants (bon marché) ──
  deepinfra: {
    kind: 'openai', endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
    label: 'DeepInfra', model: 'meta-llama/Llama-3.2-11B-Vision-Instruct',
    keyUrl: 'https://deepinfra.com/dash/api_keys', keyHint: '…', note: 'Payant, bon marché',
  },
  hyperbolic: {
    kind: 'openai', endpoint: 'https://api.hyperbolic.xyz/v1/chat/completions',
    label: 'Hyperbolic', model: 'Qwen/Qwen2-VL-7B-Instruct',
    keyUrl: 'https://app.hyperbolic.xyz/settings', keyHint: '…', note: 'Payant, bon marché',
  },
  fireworks: {
    kind: 'openai', endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
    label: 'Fireworks AI', model: 'accounts/fireworks/models/llama-v3p2-11b-vision-instruct',
    keyUrl: 'https://fireworks.ai/account/api-keys', keyHint: 'fw_…', note: 'Payant, bon marché',
  },
  openai: {
    kind: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions',
    label: 'OpenAI (GPT-4o-mini)', model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…', note: 'Payant, très bon marché',
  },
  xai: {
    kind: 'openai', endpoint: 'https://api.x.ai/v1/chat/completions',
    label: 'xAI (Grok vision)', model: 'grok-2-vision-1212',
    keyUrl: 'https://console.x.ai', keyHint: 'xai-…', note: 'Payant (Grok)',
  },
  anthropic: {
    kind: 'anthropic', label: 'Anthropic (Claude)', model: 'claude-sonnet-4-6',
    keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-…', note: 'Payant, haute qualité',
  },
};

function aiError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Texte brut du modèle → tableau [{en, fr}]. Tolère un éventuel bloc ```json.
function parseAiBlocks(raw, label) {
  if (!raw) throw aiError(`${label} : réponse vide.`, 'EMPTY_RESPONSE');
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch { throw aiError(`${label} : réponse non-JSON.`, 'JSON_PARSE'); }
  const blocks = Array.isArray(parsed) ? parsed : parsed?.blocks;
  if (!Array.isArray(blocks)) throw aiError(`${label} : format inattendu.`, 'BAD_FORMAT');
  return blocks.map(b => ({ en: b.en || '', fr: b.fr || '', lang: (b.lang || '').toLowerCase() })).filter(b => b.en || b.fr);
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'INVALID_KEY';
  if (status === 429) return 'QUOTA';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status >= 500) return 'SERVER';
  return 'HTTP_ERROR';
}

async function postJson(url, headers, body, label) {
  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw aiError(`${label} : erreur réseau.`, 'NETWORK');
  }
  if (!resp.ok) {
    let detail = '';
    try { const j = await resp.json(); detail = j?.error?.message || j?.message || ''; } catch {}
    const code = httpErrorCode(resp.status);
    const msg =
      code === 'QUOTA'           ? `${label} : quota dépassé.${detail ? ' ' + detail : ''}` :
      code === 'INVALID_KEY'     ? `${label} : clé invalide ou non autorisée.` :
      code === 'MODEL_NOT_FOUND' ? `${label} : modèle introuvable.${detail ? ' ' + detail : ''}` :
                                   `${label} : erreur HTTP ${resp.status}.${detail ? ' ' + detail : ''}`;
    throw aiError(msg, code);
  }
  try { return await resp.json(); }
  catch { throw aiError(`${label} : réponse illisible.`, 'PARSE_ERROR'); }
}

// ── Gemini (Google) ─────────────────────────────────────────────────────────────
async function analyzeGemini(key, model, b64, mime) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const data = await postJson(url, { 'Content-Type': 'application/json' }, {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: AI_PROMPT }] }],
    generationConfig: { temperature: 0.2 },
  }, 'Gemini');
  return parseAiBlocks(data?.candidates?.[0]?.content?.parts?.[0]?.text, 'Gemini');
}

// ── Anthropic (Claude) ──────────────────────────────────────────────────────────
// claude-opus-4-8 refuse `temperature` → on ne l'envoie pas. En-tête direct-browser
// requis pour un appel depuis une page (inoffensif via host_permissions).
async function analyzeAnthropic(key, model, b64, mime) {
  const data = await postJson('https://api.anthropic.com/v1/messages', {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  }, {
    model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: AI_PROMPT },
      ],
    }],
  }, 'Claude');
  const txt = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseAiBlocks(txt, 'Claude');
}

// ── Compatibles OpenAI (OpenAI, Mistral, Groq) ──────────────────────────────────
async function analyzeOpenAICompatible(url, label, key, model, b64, mime) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;   // local (Ollama/LM Studio) : pas de clé
  const data = await postJson(url, headers, {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: AI_PROMPT },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    }],
    temperature: 0.2,
  }, label);
  return parseAiBlocks(data?.choices?.[0]?.message?.content, label);
}

// Aiguillage piloté par la méta (`kind` + `endpoint`). Lève une Error avec
// .code (NO_KEY, INVALID_KEY, QUOTA, …). Ajouter un fournisseur compatible OpenAI
// = une entrée dans AI_PROVIDERS (+ son domaine dans le CSP connect-src).
async function analyzeWithProvider(id, key, model, b64, mime) {
  const meta = AI_PROVIDERS[id];
  if (!meta) throw aiError(`Fournisseur inconnu : ${id}`, 'UNKNOWN');
  if (!key && !meta.noKey) throw aiError(`${meta.label} : pas de clé.`, 'NO_KEY');
  const m = model || meta.model;
  if (meta.kind === 'gemini')    return analyzeGemini(key, m, b64, mime);
  if (meta.kind === 'anthropic') return analyzeAnthropic(key, m, b64, mime);
  return analyzeOpenAICompatible(meta.endpoint, meta.label, key, m, b64, mime);
}
