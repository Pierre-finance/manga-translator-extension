// Noise-only line pattern: line made of only symbol/punctuation chars
const NOISE_ONLY_RE = /^[=~—–_|\\/<>*#@°`´'"(){}[\].,:;!?\-\s]+$/;

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

  // 1 → I in uppercase-dominated context
  // If the line is >70% uppercase letters, treat standalone "1" as "I"
  const nonSpace = l.replace(/\s/g, '');
  if (nonSpace.length > 0) {
    const upperCount = (l.match(/[A-Z]/g) || []).length;
    if (upperCount / nonSpace.length > 0.7) {
      l = l.replace(/\b1\b/g, 'I');
    }
  }

  // 0 → O inside alphabetic words (e.g. "C0ME" → "COME")
  l = l.replace(/(?<=[a-zA-Z])0(?=[a-zA-Z])/g, 'O');

  // Normalize whitespace
  l = l.replace(/\s+/g, ' ').trim();

  return l;
}

function isUsableLine(line) {
  if (!line) return false;
  if (NOISE_ONLY_RE.test(line)) return false;

  const nonSpace = line.replace(/\s/g, '');
  if (nonSpace.length === 0) return false;

  const letters = (line.match(/[a-zA-Z]/g) || []).length;
  return letters / nonSpace.length >= 0.4;
}
