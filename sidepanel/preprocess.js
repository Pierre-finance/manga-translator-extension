// Détecte un fond sombre et inverse les couleurs si nécessaire.
// Retourne { url, inverted } — fonctionne sur l'image brute sans upscale.
async function autoInvertIfNeeded(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const n = canvas.width * canvas.height;

      // Luminosité moyenne (luminance perceptuelle)
      let sum = 0;
      for (let i = 0; i < n; i++) {
        sum += 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      }
      const avg = sum / n;

      if (avg >= 110) {
        console.log(`[MT] Luminosité: ${avg.toFixed(0)} → pas d'inversion`);
        resolve({ url: dataUrl, inverted: false });
        return;
      }

      // Fond sombre → inversion (négatif)
      for (let i = 0; i < n; i++) {
        data[i * 4]     = 255 - data[i * 4];
        data[i * 4 + 1] = 255 - data[i * 4 + 1];
        data[i * 4 + 2] = 255 - data[i * 4 + 2];
      }
      ctx.putImageData(imageData, 0, 0);
      console.log(`[MT] Luminosité: ${avg.toFixed(0)} → INVERSION appliquée (fond sombre détecté)`);
      resolve({ url: canvas.toDataURL('image/png'), inverted: true });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Recadre et upscale une zone de l'image (utilisé par le re-zoom automatique).
function cropAndUpscale(dataUrl, { x, y, w, h }, scale = 3) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Clampage aux dimensions réelles de l'image
      const cx = Math.max(0, Math.round(x));
      const cy = Math.max(0, Math.round(y));
      const cw = Math.min(Math.round(w), img.naturalWidth  - cx);
      const ch = Math.min(Math.round(h), img.naturalHeight - cy);
      if (cw <= 0 || ch <= 0) { resolve(dataUrl); return; }

      const canvas = document.createElement('canvas');
      canvas.width  = cw * scale;
      canvas.height = ch * scale;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Pré-traitement complet : upscale + grayscale + inversion si fond sombre + contraste doux.
async function preprocessImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = w < 400 ? 3 : w < 800 ? 2 : 1;

      const canvas = document.createElement('canvas');
      canvas.width  = w * scale;
      canvas.height = h * scale;

      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      const n = canvas.width * canvas.height;

      // Grayscale (luminance) + calcul luminosité moyenne
      const gray = new Uint8Array(n);
      let sumLum = 0;
      for (let i = 0; i < n; i++) {
        gray[i] = Math.round(0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]);
        sumLum += gray[i];
      }
      const avgLum = sumLum / n;

      // Inversion si fond sombre (même seuil qu'autoInvertIfNeeded)
      const inverted = avgLum < 110;
      if (inverted) {
        for (let i = 0; i < n; i++) gray[i] = 255 - gray[i];
      }
      console.log(`[MT] Prétraitement: ${w}×${h}→${canvas.width}×${canvas.height} (×${scale}), luminosité: ${avgLum.toFixed(0)}${inverted ? ' → INVERSÉ' : ''}`);

      // Étirement de contraste modéré via percentiles p1/p99 (pas de binarisation)
      const hist = new Int32Array(256);
      for (let i = 0; i < n; i++) hist[gray[i]]++;
      let cumul = 0, p1 = 0, p99 = 255;
      const t1 = n * 0.01, t99 = n * 0.99;
      for (let v = 0; v < 256; v++) {
        cumul += hist[v];
        if (cumul < t1)  p1  = v;
        if (cumul < t99) p99 = v;
      }
      const range = p99 - p1 || 1;
      console.log(`[MT] Contraste: p1=${p1} p99=${p99}`);

      for (let i = 0; i < n; i++) {
        const v = Math.min(255, Math.max(0, Math.round((gray[i] - p1) / range * 255)));
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
