// OCR con Tesseract.js. Tesseract ya ejecuta el reconocimiento en un Web Worker propio;
// aquí lo cargamos bajo demanda, informamos del progreso y lo liberamos tras un rato sin uso
// para no retener memoria en iPhones antiguos.

const TESSERACT_VERSION = '7.0.0';
const CORE_PATH = `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_VERSION}`;
const LANG_PATH_BASE = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data'; // + /<lang>/4.0.0_best_int
const IDLE_MS = 90_000;
export const MAX_OCR_SIDE = 1600;

let scriptPromise = null;
let worker = null;
let workerLang = null;
let workerPromise = null;
let idleTimer = null;
let progressCb = null;

const STATUS_ES = {
  'loading tesseract core': 'Cargando motor OCR',
  'initializing tesseract': 'Iniciando OCR',
  'initialized tesseract': 'OCR iniciado',
  'loading language traineddata': 'Descargando idioma',
  'loading language traineddata (from cache)': 'Cargando idioma',
  'loaded language traineddata': 'Idioma cargado',
  'initializing api': 'Preparando',
  'initialized api': 'Preparado',
  'recognizing text': 'Reconociendo texto',
};

function loadScript() {
  if (self.Tesseract) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/tesseract/tesseract.min.js', import.meta.url).href;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('No se pudo cargar Tesseract')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

function logger(m) {
  if (!progressCb || !m) return;
  progressCb({
    status: STATUS_ES[m.status] || m.status || '',
    progress: typeof m.progress === 'number' ? m.progress : 0,
    recognizing: m.status === 'recognizing text',
  });
}

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (workerPromise && workerLang === lang) return workerPromise;
  await terminate();
  workerLang = lang;
  workerPromise = (async () => {
    await loadScript();
    const w = await self.Tesseract.createWorker(lang, 1, {
      // Worker servido desde nuestro origen (en iOS los Worker de otro origen fallan).
      workerPath: new URL('../vendor/tesseract/worker.min.js', import.meta.url).href,
      workerBlobURL: false,
      corePath: CORE_PATH,
      // langPath por defecto: jsDelivr @tesseract.js-data/<lang>/4.0.0_best_int
      cacheMethod: 'write', // guarda los datos del idioma en IndexedDB para usarlos sin conexión
      logger,
      errorHandler: (e) => console.warn('Tesseract', e),
    });
    worker = w;
    return w;
  })();
  try {
    return await workerPromise;
  } catch (err) {
    workerPromise = null;
    workerLang = null;
    throw err;
  }
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { terminate(); }, IDLE_MS);
}

export async function terminate() {
  clearTimeout(idleTimer);
  const w = worker;
  worker = null;
  workerPromise = null;
  workerLang = null;
  if (w) { try { await w.terminate(); } catch { /* ignorar */ } }
}

// Reconoce el texto de un canvas ya reducido (≤1600 px). onProgress({status, progress}).
// opts.params: parámetros de Tesseract solo para esta llamada (p. ej. tessedit_pageseg_mode).
// opts.rotateAuto: endereza la imagen si está algo torcida (las cajas vienen en el sistema enderezado).
// Devuelve { text, words: [{ text, x0, y0, x1, y1, line, conf }], confidence, rotateRadians }.
export async function recognize(canvas, lang, onProgress, opts = {}) {
  clearTimeout(idleTimer);
  progressCb = onProgress;
  try {
    const w = await getWorker(lang);
    const options = { ...(opts.params || {}) };
    if (opts.rotateAuto) options.rotateAuto = true;
    const { data } = await w.recognize(canvas, options, { text: true, blocks: true });
    return {
      text: (data && data.text) || '',
      words: extractWords(data),
      confidence: (data && data.confidence) || 0,
      rotateRadians: (data && data.rotateRadians) || 0,
    };
  } finally {
    progressCb = null;
    scheduleIdle();
  }
}

// Relee un recorte pequeño (un campo). Devuelve { text, conf }.
export async function recognizeRegion(canvas, lang, params) {
  clearTimeout(idleTimer);
  try {
    const w = await getWorker(lang);
    const { data } = await w.recognize(canvas, { ...params }, { text: true, blocks: true });
    const conf = (data && data.confidence) || 0;
    return { text: ((data && data.text) || '').replace(/\s+/g, ' ').trim(), conf };
  } finally {
    scheduleIdle();
  }
}

// Descarga motor e idioma por adelantado (quedan en caché para usar sin conexión).
export async function prefetch(lang, onProgress) {
  progressCb = onProgress;
  try {
    await getWorker(lang);
  } finally {
    progressCb = null;
    scheduleIdle();
  }
}

export const OCR_URLS = { CORE_PATH, LANG_PATH_BASE };

// Aplana bloques → párrafos → líneas → palabras, en orden de lectura.
function extractWords(data) {
  const out = [];
  let line = 0;
  for (const block of (data && data.blocks) || []) {
    for (const para of block.paragraphs || []) {
      for (const ln of para.lines || []) {
        for (const w of ln.words || []) {
          const text = String(w.text || '').trim();
          const b = w.bbox;
          if (!text || !b) continue;
          // Descarta "palabras" de ruido: muy baja confianza y sin letras ni números.
          if (w.confidence < 20 && !/[\p{L}\p{N}]/u.test(text)) continue;
          out.push({ text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, line, conf: w.confidence });
        }
        line++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Utilidades de imagen

// Carga un File/Blob de imagen. Safari aplica la orientación EXIF al dibujar <img>.
export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { resolve({ img, release: () => URL.revokeObjectURL(url) }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

// Dibuja una imagen/vídeo en un canvas cuyo lado largo es como máximo maxSide.
export function downscale(source, srcW, srcH, maxSide = MAX_OCR_SIDE, { grayscale = false } = {}) {
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, w, h);
  if (grayscale) {
    const id = ctx.getImageData(0, 0, w, h);
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    ctx.putImageData(id, 0, 0);
  }
  return c;
}

// Como downscale, pero también amplía (hasta maxUp) si la imagen es pequeña:
// Tesseract detecta mal letras de menos de ~20 px de alto.
export function scaleToSide(source, srcW, srcH, side = MAX_OCR_SIDE, maxUp = 2.5) {
  const scale = Math.min(maxUp, side / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, w, h);
  return c;
}

// Libera la memoria de un canvas (importante en iOS, que limita la memoria total de canvas).
export function releaseCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}
