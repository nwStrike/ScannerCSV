// Relectura de precisión de un campo: se recorta la zona de las palabras elegidas desde la imagen
// original (más resolución que la usada para detectar), se amplía al tamaño de letra ideal para
// Tesseract, se prueban dos preprocesados y se queda el resultado con más confianza.
import * as ocr from './ocr.js';
import { grayStretch, adaptiveBinarize, cropScaled, cloneCanvas, meanLuma, invert } from './preprocess.js';
import { cleanValue, tessParams } from './fieldtypes.js';
import { matchBarcode, lev } from './barcodematch.js';

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
  const words = normalizeLine(indices.map((i) => allWords[i]).filter(Boolean));
  if (!words.length) return null;
  const k = sourceW / ocrW;
  let x0 = Math.min(...words.map((w) => w.x0));
  const y0 = Math.min(...words.map((w) => w.y0));
  let x1 = Math.max(...words.map((w) => w.x1));
  const y1 = Math.max(...words.map((w) => w.y1));
  const hAvg = words.reduce((a, w) => a + (w.y1 - w.y0), 0) / words.length;
  // A veces la detección corta la palabra («E89744CF4» sin el «22»): se alarga mientras haya tinta.
  const ext = extendByInk(source, k, allWords, new Set(indices), { x0, y0, x1, y1 }, hAvg, ocrW);
  x0 = ext.x0; x1 = ext.x1;
  // ¿Una sola línea? (centros verticales parecidos)
  const cys = words.map((w) => (w.y0 + w.y1) / 2);
  const singleLine = Math.max(...cys) - Math.min(...cys) < hAvg * 0.6;

  // Margen sin invadir las palabras vecinas (si no, se cuelan «:», «-» o letras de al lado).
  const chosen = new Set(indices);
  let padL = hAvg * 0.6, padR = hAvg * 0.6, padT = hAvg * 0.45, padB = hAvg * 0.45;
  allWords.forEach((w, i) => {
    if (chosen.has(i) || w.hidden) return;
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
  const makeRect = (pt, pb) => {
    const r = { x: Math.max(0, (x0 - padL) * k), y: Math.max(0, (y0 - pt) * k) };
    r.w = Math.min(sourceW - r.x, (x1 - x0 + padL + padR) * k);
    r.h = Math.min(srcH - r.y, (y1 - y0 + pt + pb) * k);
    return r;
  };
  const rect = makeRect(padT, padB);
  if (rect.w < 2 || rect.h < 2) return null;
  // Dos márgenes verticales (normal y ajustado): la lectura de Tesseract cambia mucho con unos pocos
  // píxeles de la línea de encima o de debajo; con ambos, las lecturas que coinciden son más fiables.
  const tightT = Math.min(padT, hAvg * 0.18), tightB = Math.min(padB, hAvg * 0.18);
  const rects = [['', rect]];
  if (padT - tightT > 1 || padB - tightB > 1) rects.push(['·ajustado', makeRect(tightT, tightB)]);

  const params = tessParams(type, singleLine);
  const candidates = [];
  // Lectura inicial (la de la detección): es la referencia y solo se sustituye con pruebas claras.
  const plainText = cleanValue(type, trimEdges(words.map((w) => w.text).join(' '), type));
  const plainConf = words.reduce((acc, w) => acc + (w.conf || 0), 0) / words.length;
  const extended = ext.x0 < Math.min(...words.map((w) => w.x0)) - hAvg * 0.3 || ext.x1 > Math.max(...words.map((w) => w.x1)) + hAvg * 0.3;
  const initial = plainText ? { text: plainText, conf: plainConf, votes: 1, src: 'detección' } : null;

  // Varias escalas × dos preprocesados; cada recorte es pequeño (decenas de ms).
  outer:
  for (const target of TARGETS) {
    for (const [tag, rc] of rects) {
      let scale = target / Math.max(1, hAvg * k);
      scale = Math.min(4, Math.max(0.5, scale));
      scale = Math.min(scale, MAX_SIDE / rc.w, MAX_SIDE / rc.h);
      const base = grayStretch(cropScaled(source, rc, scale, 24));
      if (meanLuma(base) < 110) invert(base); // texto claro sobre fondo oscuro
      const bin = adaptiveBinarize(cloneCanvas(base));
      for (const [canvas, name] of [[base, 'gris'], [bin, 'b/n']]) {
        const r = await ocr.recognizeRegion(canvas, lang, params);
        const text = cleanValue(type, trimEdges(r.text, type));
        if (text) candidates.push({ text, conf: r.conf, src: `${name}@${target}${tag}` });
      }
      base.width = base.height = 0;
      bin.width = bin.height = 0;
      // Si ya hay una lectura muy segura y repetida, no hace falta seguir.
      const top = pickBest(candidates);
      if (top && top.conf >= GOOD_CONF && top.votes >= 2) break outer;
    }
  }
  const sure = words.filter((w) => (w.conf || 0) >= SURE_CONF).map((w) => cleanValue(type, trimEdges(w.text, type)));
  const unsure = words.some((w) => (w.conf || 0) < SURE_CONF);
  const best = decide(initial, pickBest(candidates), { extended, sure, unsure });
  if (!best) return null;
  return { text: best.text, conf: Math.min(100, best.conf), votes: best.votes, src: best.src };
}

const N = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const SURE_CONF = 70; // confianza de palabra a partir de la cual la lectura inicial se da por buena

// ¿Contiene `text` todas las palabras `parts` en orden? (admite 1 error en palabras de 8+ caracteres)
function containsInOrder(text, parts) {
  const t = N(text);
  let from = 0;
  for (const p of parts) {
    const w = N(p);
    if (!w) continue;
    const tol = w.length >= 8 ? 1 : 0;
    let found = -1;
    for (let i = from; i + w.length <= t.length; i++) {
      let d = 0;
      for (let j = 0; j < w.length && d <= tol; j++) if (t[i + j] !== w[j]) d++;
      if (d <= tol) { found = i; break; }
    }
    if (found < 0) return false;
    from = found + w.length;
  }
  return true;
}

// ¿Es `longer` la misma lectura que `shorter` pero completada (le faltaba un trozo al principio o al final)?
function isCompletion(shorter, longer) {
  const a = N(shorter), b = N(longer);
  if (b.length <= a.length || a.length < 3) return false;
  const tol = a.length >= 8 ? 1 : 0;
  return lev(b.slice(0, a.length), a) <= tol || lev(b.slice(b.length - a.length), a) <= tol;
}

// Elige entre la lectura inicial y la mejor relectura. Principio: la comprobación puede sustituir
// lo que la primera lectura leyó con dudas, nunca lo que leyó con seguridad. La relectura gana si:
//  · completa una palabra que la detección cortó (y hubo tinta de más), o
//  · conserva todas las palabras seguras de la inicial y solo cambia/añade las dudosas, o
//  · es parecida a la inicial (corrige pocos caracteres) y varias relecturas coinciden con más
//    confianza, o la inicial era muy dudosa.
function decide(initial, refined, { extended = false, sure = [], unsure = false } = {}) {
  if (!initial) return refined;
  if (!refined) return initial;
  if (refined.text === initial.text) {
    return { ...initial, conf: Math.max(initial.conf, refined.conf), votes: refined.votes + 1 };
  }
  if (extended && refined.conf >= 60 && isCompletion(initial.text, refined.text)) return refined;
  if ((unsure || extended) && sure.length && refined.conf >= 60 && (refined.votes >= 2 || refined.conf >= 80)
      && containsInOrder(refined.text, sure) && N(refined.text).length >= N(sure.join('')).length) return refined;
  const a = N(initial.text), b = N(refined.text);
  const rel = lev(a, b) / Math.max(1, a.length, b.length);
  if (rel > 0.34) return initial;
  const strong = refined.votes >= 2 && refined.conf >= initial.conf + 8;
  const weakInitial = initial.conf < 55 && refined.conf >= initial.conf + 20;
  return strong || weakInitial ? refined : initial;
}

// Tesseract a veces da a una palabra una caja mucho más alta de lo real (abarca la línea de encima).
// En selecciones de varias palabras, esas cajas se ajustan a la banda mediana de su línea.
function normalizeLine(words) {
  if (words.length < 2) return words;
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[(b.length - 1) >> 1]; };
  const hMed = med(words.map((w) => w.y1 - w.y0));
  const normal = words.filter((w) => w.y1 - w.y0 <= hMed * 1.5);
  if (!normal.length) return words;
  const y0m = med(normal.map((w) => w.y0)), y1m = med(normal.map((w) => w.y1));
  return words.map((w) => {
    if (w.y1 - w.y0 <= hMed * 1.5) return w;
    // ¿La caja alta contiene la banda de la línea? Entonces se recorta a esa banda.
    if (w.y0 <= y0m + hMed * 0.3 && w.y1 >= y1m - hMed * 0.3) return { ...w, y0: y0m, y1: y1m };
    return w;
  });
}

// Alarga la caja a izquierda/derecha mientras haya tinta en la misma línea, sin pisar otras palabras
// ni saltar huecos mayores que medio carácter de alto.
function extendByInk(source, k, allWords, chosen, box, h, ocrW) {
  const bandY0 = box.y0 + (box.y1 - box.y0) * 0.2, bandY1 = box.y1 - (box.y1 - box.y0) * 0.2;
  const span = h * 16;
  const bx0 = Math.max(0, box.x0 - span), bx1 = Math.min(ocrW, box.x1 + span);
  const bw = Math.max(1, Math.round(bx1 - bx0)), bh = Math.max(1, Math.round(bandY1 - bandY0));
  // Otras palabras en la misma franja: no se puede entrar en ellas.
  const blockers = allWords.filter((w, i) => !chosen.has(i) && !w.bc && !w.hidden && Math.min(w.y1, bandY1) - Math.max(w.y0, bandY0) > 0);
  const c = document.createElement('canvas');
  c.width = bw; c.height = bh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, bx0 * k, bandY0 * k, bw * k, bh * k, 0, 0, bw, bh);
  const d = ctx.getImageData(0, 0, bw, bh).data;
  c.width = c.height = 0;
  // Umbral de Otsu en la franja.
  const g = new Uint8Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) { g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; hist[g[i]]++; }
  const thr = otsu(hist, g.length);
  const ink = new Uint16Array(bw);
  for (let x = 0; x < bw; x++) for (let y = 0; y < bh; y++) if (g[y * bw + x] < thr) ink[x]++;
  const minInk = Math.max(1, Math.round(bh * 0.08));
  const maxGap = h * 0.38; // menor que un espacio entre palabras
  const blocked = (x) => blockers.some((w) => x >= w.x0 - 1 && x <= w.x1 + 1);
  let nx1 = box.x1, gap = 0;
  for (let x = Math.ceil(box.x1 - bx0); x < bw; x++) {
    const X = bx0 + x;
    if (blocked(X)) break;
    if (ink[x] >= minInk) { nx1 = X + 1; gap = 0; } else if (++gap > maxGap) break;
  }
  let nx0 = box.x0;
  gap = 0;
  for (let x = Math.floor(box.x0 - bx0) - 1; x >= 0; x--) {
    const X = bx0 + x;
    if (blocked(X)) break;
    if (ink[x] >= minInk) { nx0 = X; gap = 0; } else if (++gap > maxGap) break;
  }
  return { x0: Math.max(nx0, box.x0 - span), x1: Math.min(nx1, box.x1 + span) };
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
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

/**
 * Lee el valor de un campo: código de barras si la selección lo incluye o el texto coincide con uno
 * cercano; si no, relectura de precisión (que también se contrasta con los códigos).
 * Las cajas de `barcodes` y `words` están en coordenadas de la imagen de detección.
 */
export async function readField({ source, sourceW, ocrW, words, indices, type = 'texto', lang = 'spa', barcodes = [] }) {
  const sel = indices.map((i) => words[i]).filter(Boolean);
  if (!sel.length) return null;
  if (sel.some((w) => w.bc)) {
    const text = sel.filter((w) => w.bc).map((w) => w.text).join(' ');
    return { text: cleanValue(type === 'numero' || type === 'fecha' ? type : 'texto', text), conf: 100, src: 'barcode' };
  }
  const box = {
    x0: Math.min(...sel.map((w) => w.x0)), y0: Math.min(...sel.map((w) => w.y0)),
    x1: Math.max(...sel.map((w) => w.x1)), y1: Math.max(...sel.map((w) => w.y1)),
  };
  const plain = sel.map((w) => w.text).join(' ');
  // Primero se relee (así una palabra cortada se completa) y después se contrasta con los códigos.
  const r = await refineWords(source, sourceW, ocrW, words, indices, { type, lang });
  const reads = [];
  if (r && r.text) reads.push({ text: r.text, conf: r.conf });
  if (!r || N(r.text) !== N(plain)) reads.push({ text: plain, conf: sel.reduce((a, w) => a + (w.conf || 0), 0) / sel.length });
  let best = null;
  for (const rd of reads) {
    const m = matchBarcode(rd.text, box, barcodes);
    if (!m) continue;
    // El código no puede «borrar» caracteres que el OCR sí vio (sería otro dato, p. ej. otro código cercano).
    if (N(m.value).length < N(rd.text).length) continue;
    // Si el OCR estaba muy seguro de un texto claramente distinto, no se corrige.
    if (rd.conf >= 90 && m.rel > 0.2) continue;
    if (!best || m.rel < best.rel || (m.rel === best.rel && N(rd.text).length > best.len)) best = { ...m, len: N(rd.text).length };
  }
  if (best) return { text: best.value, conf: 99, src: 'barcode' };
  return r;
}
