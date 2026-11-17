// Relectura de precisión de un campo: se recorta la zona de las palabras elegidas desde la imagen
// original (más resolución que la usada para detectar), se amplía al tamaño de letra ideal para
// Tesseract, se prueban dos preprocesados y se queda el resultado con más confianza.
import * as ocr from './ocr.js';
import { grayStretch, adaptiveBinarize, cropScaled, cloneCanvas, meanLuma, invert } from './preprocess.js';
import { cleanValue, tessParams } from './fieldtypes.js';

const TARGETS = [42, 30, 56]; // alturas de palabra (px) que se prueban en el recorte
const MAX_SIDE = 1600;
const GOOD_CONF = 88;

/**
 * @param {CanvasImageSource} source  imagen original (p. ej. el <img> de la vista previa)
 * @param {number} sourceW            ancho natural de la fuente
 * @param {number} ocrW               ancho de la imagen en la que se detectaron las palabras
 * @param {Array} allWords            todas las palabras detectadas (coordenadas de detección)
 * @param {number[]} indices          índices de las palabras elegidas
 * @param {object} o                  { type, lang }
 * @returns {Promise<{text: string, conf: number, raw: string}|null>}
 */
export async function refineWords(source, sourceW, ocrW, allWords, indices, { type = 'texto', lang = 'spa' } = {}) {
  const words = indices.map((i) => allWords[i]).filter(Boolean);
  if (!words.length) return null;
  const k = sourceW / ocrW;
  const x0 = Math.min(...words.map((w) => w.x0)), y0 = Math.min(...words.map((w) => w.y0));
  const x1 = Math.max(...words.map((w) => w.x1)), y1 = Math.max(...words.map((w) => w.y1));
  const hAvg = words.reduce((a, w) => a + (w.y1 - w.y0), 0) / words.length;
  // ¿Una sola línea? (centros verticales parecidos)
  const cys = words.map((w) => (w.y0 + w.y1) / 2);
  const singleLine = Math.max(...cys) - Math.min(...cys) < hAvg * 0.6;

  // Margen sin invadir las palabras vecinas (si no, se cuelan «:», «-» o letras de al lado).
  const chosen = new Set(indices);
  let padL = hAvg * 0.6, padR = hAvg * 0.6, padT = hAvg * 0.45, padB = hAvg * 0.45;
  allWords.forEach((w, i) => {
    if (chosen.has(i)) return;
    const overlapY = Math.min(w.y1, y1) - Math.max(w.y0, y0) > 0;
    const overlapX = Math.min(w.x1, x1) - Math.max(w.x0, x0) > 0;
    if (overlapY) {
      if (w.x1 <= x0) padL = Math.min(padL, (x0 - w.x1) * 0.5);
      if (w.x0 >= x1) padR = Math.min(padR, (w.x0 - x1) * 0.5);
    }
    if (overlapX) {
      if (w.y1 <= y0) padT = Math.min(padT, (y0 - w.y1) * 0.5);
      if (w.y0 >= y1) padB = Math.min(padB, (w.y0 - y1) * 0.5);
    }
  });
  padL = Math.max(1, padL); padR = Math.max(1, padR); padT = Math.max(1, padT); padB = Math.max(1, padB);

  const srcH = (source.naturalHeight || source.height);
  const rect = { x: Math.max(0, (x0 - padL) * k), y: Math.max(0, (y0 - padT) * k) };
  rect.w = Math.min(sourceW - rect.x, (x1 - x0 + padL + padR) * k);
  rect.h = Math.min(srcH - rect.y, (y1 - y0 + padT + padB) * k);
  if (rect.w < 2 || rect.h < 2) return null;

  const params = tessParams(type, singleLine);
  const candidates = [];
  // Lectura de la detección inicial como candidata (a veces es la buena).
  const plainText = cleanValue(type, trimEdges(words.map((w) => w.text).join(' '), type));
  const plainConf = words.reduce((acc, w) => acc + (w.conf || 0), 0) / words.length;
  if (plainText) candidates.push({ text: plainText, conf: plainConf, src: 'detección' });

  // Varias escalas × dos preprocesados; cada recorte es pequeño (decenas de ms).
  for (const target of TARGETS) {
    let scale = target / Math.max(1, hAvg * k);
    scale = Math.min(4, Math.max(0.5, scale));
    scale = Math.min(scale, MAX_SIDE / rect.w, MAX_SIDE / rect.h);
    const base = grayStretch(cropScaled(source, rect, scale, 24));
    if (meanLuma(base) < 110) invert(base); // texto claro sobre fondo oscuro
    const bin = adaptiveBinarize(cloneCanvas(base));
    for (const [canvas, name] of [[base, 'gris'], [bin, 'b/n']]) {
      const r = await ocr.recognizeRegion(canvas, lang, params);
      const text = cleanValue(type, trimEdges(r.text, type));
      if (text) candidates.push({ text, conf: r.conf, src: `${name}@${target}` });
    }
    base.width = base.height = 0;
    bin.width = bin.height = 0;
    // Si ya hay una lectura muy segura y repetida, no hace falta seguir.
    const top = pickBest(candidates);
    if (top && top.conf >= GOOD_CONF && top.votes >= 2) break;
  }
  const best = pickBest(candidates);
  if (!best) return null;
  return { text: best.text, conf: Math.min(100, best.conf), votes: best.votes, src: best.src };
}

// Agrupa lecturas iguales: puntuación = mejor confianza + 8 por cada lectura que coincide.
function pickBest(cands) {
  const groups = new Map();
  for (const c of cands) {
    const g = groups.get(c.text) || { text: c.text, conf: 0, votes: 0, src: c.src };
    g.votes++;
    if (c.conf > g.conf) { g.conf = c.conf; g.src = c.src; }
    groups.set(c.text, g);
  }
  let best = null;
  for (const g of groups.values()) {
    g.score = g.conf + 8 * (g.votes - 1);
    if (!best || g.score > best.score) best = g;
  }
  return best;
}

// Quita puntuación suelta en los bordes (restos de «LOTE:», guiones de separación…).
function trimEdges(text, type) {
  let s = String(text || '').trim().replace(/^[\s:;,.|'"`´~_\-–—=]+/, '');
  if (type !== 'texto') s = s.replace(/[\s:;,.|'"`´~_\-–—=]+$/, '');
  return s.trim();
}
