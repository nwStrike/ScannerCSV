// Verificación del OCR con los códigos de barras de la propia etiqueta.
// En muchas etiquetas (portátiles, cajas, palés) cada dato lleva su código de barras al lado:
// si el texto leído se parece al contenido de un código cercano, se usa el valor del código,
// que es exacto.

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Valores que la etiqueta puede mostrar en texto para un código:
// el contenido tal cual, EAN-13 para UPC-A (cero delante) y el contenido sin
// identificador de datos ANSI MH10.8.2 delante («S», «1S», «31P», «30S»…).
export function barcodeVariants(b) {
  const vals = [b.text];
  if (b.format === 'UPC_A' && /^\d{12}$/.test(b.text)) vals.push('0' + b.text);
  const m = String(b.text).match(/^(\d{0,3}[A-Z])(.{4,})$/);
  if (m) vals.push(m[2]);
  return [...new Set(vals)];
}

// Distancia relativa entre el texto leído y la mejor variante del código.
function bestVariant(text, b) {
  const t = norm(text);
  let best = null;
  for (const v of barcodeVariants(b)) {
    const d = lev(t, norm(v));
    const rel = d / Math.max(1, norm(v).length);
    if (!best || rel < best.rel) best = { value: v, rel, d };
  }
  return best;
}

/**
 * Busca un código que confirme (o corrija) el texto leído.
 * @param {string} text   texto del OCR
 * @param {object} box    { x0, y0, x1, y1 } de las palabras (coordenadas de detección)
 * @param {Array} barcodes códigos con caja en las mismas coordenadas
 * @returns {{ value: string, exact: boolean } | null}
 */
export function matchBarcode(text, box, barcodes) {
  const t = norm(text);
  if (t.length < 4 || !barcodes || !barcodes.length) return null;
  const h = Math.max(1, box.y1 - box.y0);
  let best = null;
  for (const b of barcodes) {
    const v = bestVariant(text, b);
    if (!v) continue;
    // ¿Está el código justo encima o debajo, y solapado en horizontal? Entonces se admiten más errores.
    const overlapX = Math.min(b.x1, box.x1) - Math.max(b.x0, box.x0) > -h;
    const gap = b.y0 >= box.y1 ? b.y0 - box.y1 : box.y0 >= b.y1 ? box.y0 - b.y1 : 0;
    const near = overlapX && gap < h * 4;
    const limit = near ? 0.4 : 0.2;
    if (v.rel <= limit && (!best || v.rel < best.rel || (v.rel === best.rel && near && !best.near))) {
      best = { value: v.value, rel: v.rel, near, exact: v.d === 0 };
    }
  }
  return best ? { value: keepFormat(text, best.value), exact: best.exact, rel: best.rel } : null;
}

// Conserva los separadores del texto impreso («390798D2-61BC-…») si el código los omite.
export function keepFormat(ocrText, value) {
  const t = String(ocrText || '').trim();
  const seps = [];
  let n = 0;
  for (const ch of t) {
    if (/[A-Za-z0-9]/.test(ch)) n++;
    else if (/[-/.:]/.test(ch)) seps.push([n, ch]);
  }
  const v = norm(value);
  if (!seps.length || norm(value) !== String(value).toUpperCase() || Math.abs(n - v.length) > 2) return value;
  let out = '', k = 0;
  for (let i = 0; i <= v.length; i++) {
    while (k < seps.length && seps[k][0] === i) { if (i > 0 && i < v.length) out += seps[k][1]; k++; }
    if (i < v.length) out += v[i];
  }
  return out;
}

// Texto a mostrar para un código suelto: la variante que coincide con alguna palabra
// cercana de la etiqueta; si no, EAN-13 para UPC-A o el contenido tal cual.
export function barcodeDisplay(b, words) {
  const vars = barcodeVariants(b);
  let best = null;
  for (const w of words || []) {
    const near = Math.abs((w.y0 + w.y1) / 2 - (b.y0 + b.y1) / 2) < (b.y1 - b.y0) * 3 + (w.y1 - w.y0) * 3;
    if (!near || norm(w.text).length < 4) continue;
    for (const v of vars) {
      const rel = lev(norm(w.text), norm(v)) / Math.max(1, norm(v).length);
      if (rel <= 0.4 && (!best || rel < best.rel)) best = { v, rel };
    }
  }
  if (best) return best.v;
  if (b.format === 'UPC_A' && /^\d{12}$/.test(b.text)) return '0' + b.text;
  return b.text;
}
