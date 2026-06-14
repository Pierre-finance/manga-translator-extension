const NOISE_ONLY_RE = /^[=~—–_|\\/<>*#@°`´'"(){}[\].,:;!?\-\s]+$/;

// Verbes/mots qui, en début de phrase après "me", signalent l'erreur OCR w→m
const WE_TRIGGERS = new Set([
  'can', "can't", 'cannot', 'could', "couldn't",
  'will', "won't", 'would', "wouldn't",
  'should', "shouldn't", 'shall',
  'must', "mustn't", 'need', "needn't",
  'have', "haven't", 'had', "hadn't",
  'are', "aren't", 'were', "weren't",
  'do', "don't", 'did', "didn't",
  'all', 'too',
]);

// Reconstruit block.text depuis les bounding boxes de mots pour corriger les espaces collés.
// Doit être appelé avant cleanBlocks sur le résultat brut de Tesseract.
function fixBlockSpacing(blocks) {
  return blocks.map(block => {
    const lines = block.lines || [];
    if (lines.length === 0 || !lines[0].words) return block;

    const text = lines.map(line => {
      const words = (line.words || [])
        .filter(w => w.text && w.text.trim().length > 0)
        .sort((a, b) => a.bbox.x0 - b.bbox.x0);

      if (words.length === 0) return '';

      let lineText = words[0].text;
      for (let i = 1; i < words.length; i++) {
        // Espace si les bboxes ne se chevauchent pas (seuil -2px pour arrondi)
        if (words[i].bbox.x0 - words[i - 1].bbox.x1 >= -2) lineText += ' ';
        lineText += words[i].text;
      }
      return lineText;
    }).join('\n');

    return { ...block, text };
  });
}

function cleanBlocks(blocks) {
  return blocks
    .map((block) => {
      const cleaned = block.text
        .split('\n')
        .map(cleanLine)
        .filter(isUsableLine)
        .join('\n')
        .trim();

      return { ...block, text: cleaned };
    })
    .filter((block) => block.text.length >= 3);
}

function cleanLine(line) {
  let l = line.trim();

  // Strip leading/trailing noise symbol runs
  l = l.replace(/^[=~—–_|\\/<>*#@°`´'"(){}[\].,:;!?\-]+\s*/g, '');
  l = l.replace(/\s*[=~—–_|\\/<>*#@°`´'"(){}[\].,:;!?\-]+$/g, '');

  // 1 → I en contexte majoritairement majuscule (règle originale)
  const nonSpace = l.replace(/\s/g, '');
  if (nonSpace.length > 0) {
    const upperCount = (l.match(/[A-Z]/g) || []).length;
    if (upperCount / nonSpace.length > 0.7) {
      l = l.replace(/\b1\b/g, 'I');
    }
  }

  // "1" isolé entre deux mots alphabétiques (ex: "he 1 think" → "he I think")
  l = l.replace(/(?<=[a-zA-Z]) 1 (?=[a-zA-Z])/g, ' I ');

  // 0 → O à l'intérieur d'un mot alphabétique (ex: "C0ME" → "COME")
  l = l.replace(/(?<=[a-zA-Z])0(?=[a-zA-Z])/g, 'O');

  // "me <modal/aux>" en début de ligne → "we <modal/aux>" (confusion OCR w→m)
  l = l.replace(/^(me|Me) (\S+)/g, (match, me, next) => {
    if (WE_TRIGGERS.has(next.toLowerCase())) {
      return (me === 'Me' ? 'We' : 'we') + ' ' + next;
    }
    return match;
  });

  // Majuscule initiale de ligne (prudent : ne touche que la 1ère lettre si minuscule)
  l = l.replace(/^([a-z])/, c => c.toUpperCase());

  // Normalisation des espaces
  l = l.replace(/\s+/g, ' ').trim();

  return l;
}

// ── Correction par dictionnaire ───────────────────────────────────────────────

// Distance de Levenshtein avec arrêt précoce si déjà > maxDist.
function _lev(a, b, maxDist) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  const row = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    let prev = i;
    for (let j = 1; j <= lb; j++) {
      const curr = a[i - 1] === b[j - 1] ? row[j - 1] : 1 + Math.min(row[j], prev, row[j - 1]);
      row[j - 1] = prev;
      prev = curr;
    }
    row[lb] = prev;
  }
  return row[lb];
}

// Ratio de tokens alphabétiques (≥3 cars) absents du dictionnaire.
function unknownWordRatio(text) {
  if (typeof WORDLIST === 'undefined') return 0;
  const tokens = text.match(/[a-zA-Z]{3,}/g) || [];
  if (tokens.length === 0) return 0;
  const unknown = tokens.filter(t => !WORDLIST.has(t.toLowerCase())).length;
  return unknown / tokens.length;
}

// Corrige un token alphabétique (≥3 cars) en cherchant le mot le plus proche.
function _correctToken(token) {
  if (typeof WORDLIST === 'undefined') return token;
  const lc = token.toLowerCase();
  if (WORDLIST.has(lc)) return token;

  // Seuil prudent : distance 1 pour les mots courts, 2 pour les plus longs
  const maxDist = lc.length <= 4 ? 1 : 2;
  let best = null, bestDist = maxDist + 1;
  for (const w of WORDLIST) {
    if (Math.abs(w.length - lc.length) > maxDist) continue;
    const d = _lev(lc, w, maxDist);
    if (d < bestDist) {
      bestDist = d;
      best = w;
      if (d === 1) break; // distance optimale trouvée
    }
  }
  if (!best) return token;

  // Restaurer la casse originale
  if (token === token.toUpperCase()) return best.toUpperCase();
  if (token[0] === token[0].toUpperCase()) return best[0].toUpperCase() + best.slice(1);
  return best;
}

// Applique la correction dictionnaire sur tous les blocs.
function dictCorrectBlocks(blocks) {
  if (typeof WORDLIST === 'undefined') return blocks;
  return blocks.map(block => {
    const corrected = block.text.replace(/[a-zA-Z]{3,}/g, _correctToken);
    if (corrected !== block.text) {
      console.log(`[MT] Dict correction: "${block.text}" → "${corrected}"`);
    }
    return corrected !== block.text ? { ...block, text: corrected } : block;
  });
}

function isUsableLine(line) {
  if (!line) return false;
  if (NOISE_ONLY_RE.test(line)) return false;

  const nonSpace = line.replace(/\s/g, '');
  if (nonSpace.length === 0) return false;

  const letters = (line.match(/[a-zA-Z]/g) || []).length;
  return letters / nonSpace.length >= 0.4;
}
