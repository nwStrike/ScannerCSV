// Preprocesado de imagen para mejorar el OCR (etiquetas con poco contraste, brillos, letra pequeña).
// Todo trabaja sobre canvas 2D, sin dependencias.

const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Escala de grises + estiramiento de contraste (percentiles 1 % y 99 %). Modifica el canvas.
export function grayStretch(canvas) {
  const ctx = ctx2d(canvas);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  const n = d.length / 4;
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    d[j] = y;
    hist[y]++;
  }
  const lo = percentile(hist, n, 0.01);
  const hi = percentile(hist, n, 0.99);
  const range = Math.max(1, hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / range;
  for (let j = 0; j < d.length; j += 4) {
    const y = lut[d[j]];
    d[j] = d[j + 1] = d[j + 2] = y;
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

function percentile(hist, n, p) {
  const target = n * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

// Media de luminancia (0..255) de un canvas en grises.
export function meanLuma(canvas) {
  const d = ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
  let s = 0;
  for (let j = 0; j < d.length; j += 4) s += d[j];
  return s / (d.length / 4);
}

export function invert(canvas) {
  const ctx = ctx2d(canvas);
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  for (let j = 0; j < d.length; j += 4) { d[j] = 255 - d[j]; d[j + 1] = 255 - d[j + 1]; d[j + 2] = 255 - d[j + 2]; }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

// Umbral adaptativo (Bradley-Roth) con imagen integral: aguanta sombras y brillos desiguales.
// Espera un canvas ya en grises. Modifica el canvas.
export function adaptiveBinarize(canvas, { windowFrac = 1 / 12, t = 0.15 } = {}) {
  const w = canvas.width, h = canvas.height;
  const ctx = ctx2d(canvas);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += d[(y * w + x) * 4];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + row;
    }
  }
  const s = Math.max(8, Math.round(Math.max(w, h) * windowFrac)) >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - s), y1 = Math.min(h - 1, y + s);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - s), x1 = Math.min(w - 1, x + s);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * (w + 1) + (x1 + 1)] - integral[y0 * (w + 1) + (x1 + 1)]
        - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const j = (y * w + x) * 4;
      const v = d[j] * count <= sum * (1 - t) ? 0 : 255;
      d[j] = d[j + 1] = d[j + 2] = v;
    }
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

// Nitidez: varianza del laplaciano sobre una copia pequeña (≤ 480 px). Más alto = más nítido.
export function sharpness(source, sw, sh) {
  const scale = Math.min(1, 480 / Math.max(sw, sh));
  const w = Math.max(3, Math.round(sw * scale)), h = Math.max(3, Math.round(sh * scale));
  const c = makeCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) / 256;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      sum += lap; sum2 += lap * lap; n++;
    }
  }
  c.width = c.height = 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

// Gira un canvas `radians` alrededor de su centro, manteniendo el tamaño (fondo blanco).
export function rotateCanvas(src, radians) {
  const c = makeCanvas(src.width, src.height);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(radians);
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

// Recorta `rect` (coordenadas de la fuente) escalándolo, con margen blanco alrededor.
export function cropScaled(source, rect, scale, border = 16) {
  const w = Math.max(1, Math.round(rect.w * scale)), h = Math.max(1, Math.round(rect.h * scale));
  const c = makeCanvas(w + border * 2, h + border * 2);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, border, border, w, h);
  return c;
}

export function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}
