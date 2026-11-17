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

let frame = 0;
self.onmessage = async (ev) => {
  const { id, width, height, buffer, still } = ev.data;
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
