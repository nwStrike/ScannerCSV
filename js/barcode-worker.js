/* Web Worker de decodificación de códigos.
 * Lector principal: ZXing-js (todas las plataformas).
 * BarcodeDetector nativo solo como optimización si existe (no en Safari iOS). */
/* global ZXing, BarcodeDetector */
importScripts('../vendor/zxing/zxing.min.js');

const WANTED = [
  'QR_CODE', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93',
  'ITF', 'CODABAR', 'DATA_MATRIX', 'PDF_417', 'AZTEC',
];

// --- ZXing ---------------------------------------------------------------
function makeReader(tryHarder) {
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, WANTED.map((f) => ZXing.BarcodeFormat[f]));
  if (tryHarder) hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  return reader;
}
const fastReader = makeReader(false);
let hardReader = null;

function toLuminance(rgba, n) {
  const lum = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // Aproximación rápida de luminancia (prima el verde).
    lum[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return lum;
}

function zxingDecode(lum, width, height, { hybrid = true, tryHarder = false } = {}) {
  const source = new ZXing.RGBLuminanceSource(lum, width, height);
  const Binarizer = hybrid ? ZXing.HybridBinarizer : ZXing.GlobalHistogramBinarizer;
  const bitmap = new ZXing.BinaryBitmap(new Binarizer(source));
  const reader = tryHarder ? (hardReader || (hardReader = makeReader(true))) : fastReader;
  try {
    const r = reader.decodeWithState(bitmap);
    return { text: r.getText(), format: ZXing.BarcodeFormat[r.getBarcodeFormat()] };
  } catch (err) {
    return null; // NotFound / Checksum / Format: sin código en este fotograma
  } finally {
    try { reader.reset(); } catch (e) { /* ignorar */ }
  }
}

function invert(lum) {
  const out = new Uint8ClampedArray(lum.length);
  for (let i = 0; i < lum.length; i++) out[i] = 255 - lum[i];
  return out;
}

// --- BarcodeDetector (opcional) -----------------------------------------
let detector = null;
const detectorReady = (async () => {
  try {
    if (typeof BarcodeDetector === 'undefined') return;
    const supported = await BarcodeDetector.getSupportedFormats();
    const formats = WANTED.map((f) => f.toLowerCase()).filter((f) => supported.includes(f));
    if (formats.length) detector = new BarcodeDetector({ formats });
  } catch (e) {
    detector = null;
  }
})();

async function nativeDecode(rgba, width, height) {
  if (!detector) return null;
  try {
    const img = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height);
    const res = await detector.detect(img);
    if (res && res.length && res[0].rawValue) {
      return { text: res[0].rawValue, format: String(res[0].format || '').toUpperCase() };
    }
  } catch (e) {
    // Si el detector nativo falla una vez, dejamos de usarlo y seguimos con ZXing.
    detector = null;
  }
  return null;
}

// --- Varios códigos 1D en una foto (etiquetas con códigos apilados) ----------------
// 1) Se buscan zonas con rayas verticales (mucho gradiente horizontal y poco vertical).
// 2) Cada zona se separa del texto pegado y se decodifica recortada (con zona de silencio).
const ONE_D = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR'];
let oneDHints = null;
function locateBarcodes(lum, w, h) {
  if (!oneDHints) {
    oneDHints = new Map();
    oneDHints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, ONE_D.map((f) => ZXing.BarcodeFormat[f]));
    oneDHints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  }
  const c = Math.max(4, Math.round(Math.max(w, h) / 300));
  const cw = Math.floor(w / c), ch = Math.floor(h / c);
  const mark = new Uint8Array(cw * ch);
  const n = (c - 1) * (c - 1);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let gx = 0, gy = 0;
      for (let y = cy * c; y < cy * c + c - 1; y++) {
        for (let x = cx * c; x < cx * c + c - 1; x++) {
          const i = y * w + x;
          gx += Math.abs(lum[i + 1] - lum[i]);
          gy += Math.abs(lum[i + w] - lum[i]);
        }
      }
      if (gx / n > 18 && gx > 2.2 * gy) mark[cy * cw + cx] = 1;
    }
  }
  // Rellena huecos horizontales de hasta 2 celdas (barras o espacios anchos).
  const m2 = new Uint8Array(mark);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      if (mark[cy * cw + cx]) continue;
      let l = 0, r = 0;
      for (let d = 1; d <= 2; d++) {
        if (cx - d >= 0 && mark[cy * cw + cx - d]) l = 1;
        if (cx + d < cw && mark[cy * cw + cx + d]) r = 1;
      }
      if (l && r) m2[cy * cw + cx] = 1;
    }
  }
  // Componentes conexas.
  const lab = new Int32Array(cw * ch).fill(-1);
  const comps = [];
  for (let i = 0; i < cw * ch; i++) {
    if (!m2[i] || lab[i] >= 0) continue;
    const id = comps.length;
    const q = [i];
    lab[i] = id;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    while (q.length) {
      const j = q.pop();
      const x = j % cw, y = (j / cw) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m2[j - 1] && lab[j - 1] < 0) { lab[j - 1] = id; q.push(j - 1); }
      if (x < cw - 1 && m2[j + 1] && lab[j + 1] < 0) { lab[j + 1] = id; q.push(j + 1); }
      if (y > 0 && m2[j - cw] && lab[j - cw] < 0) { lab[j - cw] = id; q.push(j - cw); }
      if (y < ch - 1 && m2[j + cw] && lab[j + cw] < 0) { lab[j + cw] = id; q.push(j + cw); }
    }
    comps.push({ id, x0, y0, x1, y1 });
  }
  // Cada componente se divide en tramos de filas densas (separa el código del texto pegado).
  const cands = [];
  for (const b of comps) {
    if (b.x1 - b.x0 + 1 < 8) continue;
    let run = null;
    const flush = () => {
      if (run && run.y1 - run.y0 + 1 >= 2 && run.x1 - run.x0 + 1 >= 8) {
        cands.push({ x: run.x0 * c, y: run.y0 * c, w: (run.x1 - run.x0 + 1) * c, h: (run.y1 - run.y0 + 1) * c });
      }
      run = null;
    };
    for (let cy = b.y0; cy <= b.y1; cy++) {
      let cnt = 0, rx0 = 1e9, rx1 = -1;
      for (let cx = b.x0; cx <= b.x1; cx++) {
        if (lab[cy * cw + cx] === b.id) { cnt++; if (cx < rx0) rx0 = cx; if (cx > rx1) rx1 = cx; }
      }
      if (cnt >= 8 && cnt / (rx1 - rx0 + 1) > 0.7) {
        if (!run) run = { y0: cy, y1: cy, x0: rx0, x1: rx1 };
        else { run.y1 = cy; run.x0 = Math.min(run.x0, rx0); run.x1 = Math.max(run.x1, rx1); }
      } else flush();
    }
    flush();
  }
  const out = [];
  const seen = new Set();
  for (const b of cands) {
    const mx = Math.round(Math.max(b.h, b.w * 0.12)); // zona de silencio
    const x = Math.max(0, b.x - mx), x2 = Math.min(w, b.x + b.w + mx);
    const y = Math.max(0, b.y), y2 = Math.min(h, b.y + b.h);
    let r = null;
    for (const B of [ZXing.GlobalHistogramBinarizer, ZXing.HybridBinarizer]) {
      try {
        const src = new ZXing.RGBLuminanceSource(lum, x2 - x, y2 - y, w, h, x, y);
        r = new ZXing.MultiFormatOneDReader(oneDHints).decode(new ZXing.BinaryBitmap(new B(src)), oneDHints);
        break;
      } catch (e) { r = null; }
    }
    if (!r) continue;
    const text = r.getText();
    const format = ZXing.BarcodeFormat[r.getBarcodeFormat()];
    const key = text + '|' + Math.round(b.y / (c * 4));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, format, x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h });
  }
  // Códigos 2D (QR / Data Matrix) en la imagen completa.
  for (const R of [ZXing.QRCodeReader, ZXing.DataMatrixReader]) {
    try {
      const r = new R().decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(lum, w, h))));
      const pts = r.getResultPoints() || [];
      if (pts.length) {
        const xs = pts.map((p) => p.getX()), ys = pts.map((p) => p.getY());
        const pad = (Math.max(...xs) - Math.min(...xs)) * 0.15;
        out.push({ text: r.getText(), format: ZXing.BarcodeFormat[r.getBarcodeFormat()],
          x0: Math.max(0, Math.min(...xs) - pad), y0: Math.max(0, Math.min(...ys) - pad), x1: Math.min(w, Math.max(...xs) + pad), y1: Math.min(h, Math.max(...ys) + pad) });
      }
    } catch (e) { /* sin código 2D */ }
  }
  return out;
}

let frame = 0;
self.onmessage = async (ev) => {
  const { id, width, height, buffer, still, locate } = ev.data;
  if (locate) {
    try {
      const lum = toLuminance(new Uint8ClampedArray(buffer), width * height);
      self.postMessage({ id, barcodes: locateBarcodes(lum, width, height) });
    } catch (err) {
      self.postMessage({ id, barcodes: [], error: String(err && err.message || err) });
    }
    return;
  }
  await detectorReady;
  const rgba = new Uint8ClampedArray(buffer);
  let result = null;
  let engine = '';
  try {
    result = await nativeDecode(rgba, width, height);
    if (result) engine = 'native';
    // Con detector nativo, ZXing solo cada 3 fotogramas (formatos que el nativo no cubra).
    const skipZxing = !still && detector && (++frame % 3 !== 0);
    if (!result && !skipZxing) {
      const lum = toLuminance(rgba, width * height);
      if (still) {
        // Foto: probamos combinaciones más costosas.
        result = zxingDecode(lum, width, height, { hybrid: true, tryHarder: true })
          || zxingDecode(lum, width, height, { hybrid: false, tryHarder: true })
          || zxingDecode(invert(lum), width, height, { hybrid: true, tryHarder: true });
      } else {
        if (!detector) frame++;
        // Vídeo: alternamos binarizadores; de vez en cuando probamos códigos invertidos.
        result = zxingDecode(lum, width, height, { hybrid: frame % 2 === 0 });
        if (!result && frame % 6 === 0) result = zxingDecode(invert(lum), width, height, { hybrid: true });
      }
      if (result) engine = 'zxing';
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
    return;
  }
  self.postMessage({ id, result, engine, native: !!detector });
};
