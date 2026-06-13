async function preprocessImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = img.naturalWidth < 1200 ? 2 : 1;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const pixelCount = canvas.width * canvas.height;

      // Grayscale (luminance)
      const gray = new Uint8Array(pixelCount);
      for (let i = 0; i < pixelCount; i++) {
        gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
      }

      const threshold = computeOtsu(gray);

      // Apply threshold to pixel data
      for (let i = 0; i < pixelCount; i++) {
        const v = gray[i] < threshold ? 0 : 255;
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function computeOtsu(grayPixels) {
  const hist = new Float64Array(256);
  for (const v of grayPixels) hist[v]++;

  const total = grayPixels.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let w0 = 0, sum0 = 0, maxVar = 0, threshold = 170;

  for (let t = 0; t < 256; t++) {
    w0 += hist[t] / total;
    const w1 = 1 - w0;
    if (w0 === 0 || w1 === 0) continue;

    sum0 += t * hist[t];
    const mu0 = sum0 / (w0 * total);
    const mu1 = (sumAll - sum0) / (w1 * total);
    const varBetween = w0 * w1 * (mu0 - mu1) ** 2;

    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshold = t;
    }
  }

  // Fallback uniquement pour les images quasi-uniformes (pas de bimodalité claire).
  // Ne PAS écraser un seuil élevé : pour une bulle blanche avec texte noir,
  // Otsu donne légitimement 200-230, ce qui est correct.
  if (threshold < 50 || threshold > 245) threshold = 170;

  console.log('[MangaTranslator] Otsu threshold:', threshold, '— maxVar:', maxVar.toFixed(2));
  return threshold;
}
