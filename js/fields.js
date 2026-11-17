// Selección de campos sobre la imagen del OCR (editor a pantalla completa).
// - Un dedo: tocar una palabra la asigna/quita del campo activo; arrastrar = recuadro de selección.
// - Dos dedos: ampliar y mover la imagen. Botones +/− como alternativa.

import { cleanValue, FIELD_TYPES } from './fieldtypes.js';
import { barcodeDisplay } from './barcodematch.js';

const DOUBT_CONF = 72; // por debajo, se avisa de «lectura dudosa»
const LOW_WORD_CONF = 60;

export const FIELD_COLORS = ['#0f766e', '#c2410c', '#7c3aed', '#2563eb', '#be185d', '#15803d', '#a16207', '#0e7490', '#b91c1c', '#4d7c0f'];
export const RESERVED = ['fecha', 'tipo', 'formato', 'valor', 'nota'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAG_PX = 10;
const MAX_SCALE = 6;

export function colorFor(fields, name) {
  const i = fields.indexOf(name);
  return FIELD_COLORS[(i < 0 ? 0 : i) % FIELD_COLORS.length];
}

// Valida un nombre de campo nuevo. Devuelve { name } o { error }.
export function validateFieldName(raw, fields) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Escribe un nombre.' };
  if (RESERVED.includes(name.toLowerCase())) return { error: `«${name}» ya es una columna del CSV. Usa otro nombre.` };
  if (fields.some((f) => f.toLowerCase() === name.toLowerCase())) return { error: `El campo «${name}» ya existe.` };
  return { name };
}

export class FieldPicker {
  /**
   * @param {object} els elementos del DOM
   * @param {object} opts { getFields(), getType(field), refine(field, indices) → Promise<{text, conf}|null>,
   *                        toast(msg), requestAddField(), onDone() }
   */
  constructor(els, opts) {
    this.els = els;
    this.opts = opts;
    this.words = [];
    this.width = 1;
    this.height = 1;
    this.active = null;
    this.assign = new Map(); // índice de palabra → campo
    this.manual = new Map(); // campo → texto escrito a mano
    this.refined = new Map(); // campo → { key, text, conf } (relectura de precisión)
    this.pending = new Set(); // campos que se están releyendo
    this.refineTimers = new Map();
    // Vista: escala base (encajar) * zoom, desplazamiento en px de pantalla.
    this.view = { base: 1, zoom: 1, tx: 0, ty: 0 };
    this.pointers = new Map();
    this.gesture = null;
    this._bind();
  }

  get fields() { return this.opts.getFields(); }

  // --- Ciclo de vida -------------------------------------------------------
  load({ imgUrl, width, height, words }) {
    this.words = words || [];
    this.width = width || 1;
    this.height = height || 1;
    this.assign.clear();
    this.manual.clear();
    this.refined.clear();
    this.pending.clear();
    if (!this.fields.includes(this.active)) this.active = this.fields[0] || null;
    const { wrap, svg, img } = this.els;
    wrap.style.width = `${this.width}px`;
    wrap.style.height = `${this.height}px`;
    if (imgUrl) img.src = imgUrl;
    svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.fit();
    this.zoomToText();
    this.els.hint.classList.remove('fade');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.els.hint.classList.add('fade'), 5000);
    this.renderAll();
  }

  // Muestra solo la imagen (mientras el OCR trabaja).
  preview({ imgUrl, width, height }) {
    this.words = [];
    this.width = width || 1;
    this.height = height || 1;
    const { wrap, svg, img } = this.els;
    wrap.style.width = `${this.width}px`;
    wrap.style.height = `${this.height}px`;
    if (imgUrl) img.src = imgUrl;
    svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    svg.replaceChildren();
    this.fit();
  }

  // Añade los códigos de barras encontrados en la foto como «palabras» que se pueden tocar.
  setBarcodes(barcodes) {
    const text = this.words.filter((w) => !w.bc);
    const bcs = (barcodes || []).map((b) => ({
      text: barcodeDisplay(b, text), raw: b.text, format: b.format,
      x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, line: -1, conf: 100, bc: true,
    }));
    // «Palabras» que el OCR inventa sobre las barras: se ocultan (no se pintan ni se pueden tocar).
    text.forEach((w, i) => {
      const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
      // Una palabra que el usuario ya eligió nunca se oculta ni pierde su asignación.
      w.hidden = !this.assign.has(i) && bcs.some((b) => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1);
    });
    // Las palabras de texto conservan sus índices (los códigos van al final).
    this.words = text.concat(bcs);
    this.renderOverlay();
    // Los campos ya asignados se vuelven a contrastar con los códigos.
    this.fields.forEach((f) => { this.refined.delete(f); this.scheduleRefine(f); });
    this.renderChips(false);
    this.renderActive();
  }

  reset() {
    this.words = [];
    this.assign.clear();
    this.manual.clear();
    this.refined.clear();
    this.pending.clear();
    this.refineTimers.forEach((t) => clearTimeout(t));
    this.refineTimers.clear();
    this.els.svg.replaceChildren();
    this.els.img.removeAttribute('src');
  }

  // Valores no vacíos { campo: valor } o null.
  result() {
    const out = {};
    let any = false;
    for (const f of this.fields) {
      const v = this.valueOf(f).trim();
      if (v) { out[f] = v; any = true; }
    }
    return any ? out : null;
  }

  // Índices de las palabras de un campo, en orden de lectura (por líneas, de izquierda a derecha).
  indicesOf(field) {
    const idx = [];
    this.assign.forEach((f, i) => { if (f === field) idx.push(i); });
    const W = this.words;
    return idx.sort((a, b) => {
      const A = W[a], B = W[b];
      const ca = (A.y0 + A.y1) / 2, cb = (B.y0 + B.y1) / 2;
      const h = Math.min(A.y1 - A.y0, B.y1 - B.y0);
      return Math.abs(ca - cb) < h * 0.5 ? A.x0 - B.x0 : ca - cb;
    });
  }

  // Prioridad: escrito a mano > relectura de precisión > palabras detectadas.
  valueOf(field) {
    if (this.manual.has(field)) return this.manual.get(field);
    const idx = this.indicesOf(field);
    if (!idx.length) return '';
    const r = this.refined.get(field);
    if (r && r.key === idx.join(',')) return r.text;
    return cleanValue(this.opts.getType(field), idx.map((i) => this.words[i].text).join(' '));
  }

  // Confianza (0-100) del valor actual; null si está vacío.
  confOf(field) {
    if (this.manual.has(field)) return 100;
    const idx = this.indicesOf(field);
    if (!idx.length) return null;
    const r = this.refined.get(field);
    if (r && r.key === idx.join(',')) return r.conf;
    return idx.reduce((a, i) => a + (this.words[i].conf || 0), 0) / idx.length;
  }

  isVerified(field) {
    if (this.manual.has(field)) return false;
    const r = this.refined.get(field);
    return !!(r && r.src === 'barcode' && r.key === this.indicesOf(field).join(','));
  }

  // Relee el campo con más precisión (con un pequeño retardo mientras el usuario sigue tocando).
  scheduleRefine(field) {
    clearTimeout(this.refineTimers.get(field));
    if (!this.opts.refine || this.manual.has(field)) return;
    const idx = this.indicesOf(field);
    if (!idx.length) { this.refined.delete(field); this.pending.delete(field); return; }
    const key = idx.join(',');
    const cur = this.refined.get(field);
    if (cur && cur.key === key) return;
    this.pending.add(field);
    this.refineTimers.set(field, setTimeout(async () => {
      let r = null;
      try { r = await this.opts.refine(field, idx); } catch (err) { console.warn('refine', err); }
      if (this.indicesOf(field).join(',') !== key) return; // cambió mientras leía
      this.pending.delete(field);
      if (r && r.text) this.refined.set(field, { key, text: r.text, conf: r.conf, src: r.src });
      this.renderChips(false);
      this.renderActive();
    }, 300));
  }

  refineAll() {
    this.refined.clear();
    this.fields.forEach((f) => this.scheduleRefine(f));
    this.renderChips(false);
    this.renderActive();
  }

  filledCount() { return this.fields.filter((f) => this.valueOf(f).trim()).length; }

  // --- Campos ----------------------------------------------------------------
  fieldsChanged(newActive) {
    const fields = this.fields;
    for (const [i, f] of [...this.assign]) if (!fields.includes(f)) this.assign.delete(i);
    for (const f of [...this.manual.keys()]) if (!fields.includes(f)) this.manual.delete(f);
    for (const f of [...this.refined.keys()]) if (!fields.includes(f)) this.refined.delete(f);
    if (newActive && fields.includes(newActive)) this.active = newActive;
    if (!fields.includes(this.active)) this.active = fields[0] || null;
    this.renderAll();
  }

  setActive(name, { scroll = true } = {}) {
    this.active = name;
    this.renderChips(scroll);
    this.renderActive();
  }

  next() {
    const fields = this.fields;
    if (!fields.length) return false;
    const i = fields.indexOf(this.active);
    // Siguiente campo vacío; si no hay, el siguiente en orden.
    for (let k = 1; k <= fields.length; k++) {
      const f = fields[(i + k) % fields.length];
      if (!this.valueOf(f).trim()) { this.setActive(f); return true; }
    }
    if (i === fields.length - 1) return false; // todo relleno y estamos en el último
    this.setActive(fields[(i + 1) % fields.length]);
    return true;
  }

  clearActive() {
    const f = this.active;
    if (!f) return;
    for (const [i, ff] of [...this.assign]) if (ff === f) this.assign.delete(i);
    this.manual.delete(f);
    this.refined.delete(f);
    this.pending.delete(f);
    clearTimeout(this.refineTimers.get(f));
    this.renderOverlay();
    this.renderChips(false);
    this.renderActive();
  }

  setManual(value) {
    if (!this.active) return;
    this.manual.set(this.active, value);
    this.renderChips(false);
  }

  // --- Asignación ------------------------------------------------------------
  toggleWords(indices) {
    if (!indices.length) return;
    if (!this.fields.length) { this.opts.requestAddField(); return; }
    if (!this.active) this.active = this.fields[0];
    const f = this.active;
    const affected = new Set([f]);
    const allMine = indices.every((i) => this.assign.get(i) === f);
    for (const i of [...indices].sort((a, b) => a - b)) {
      const word = this.words[i].text;
      if (allMine) {
        this.assign.delete(i);
        if (this.manual.has(f)) this.manual.set(f, removeOnce(this.manual.get(f), word));
      } else if (this.assign.get(i) !== f) {
        const prev = this.assign.get(i);
        if (prev) affected.add(prev);
        if (prev && this.manual.has(prev)) this.manual.set(prev, removeOnce(this.manual.get(prev), word));
        this.assign.set(i, f);
        if (this.manual.has(f)) this.manual.set(f, (this.manual.get(f) + ' ' + word).trim());
      }
    }
    if (typeof navigator.vibrate === 'function') { try { navigator.vibrate(15); } catch { /* ignorar */ } }
    affected.forEach((x) => this.scheduleRefine(x));
    this.renderOverlay();
    this.renderChips(false);
    this.renderActive();
  }

  // --- Vista (zoom y desplazamiento) ---------------------------------------------
  fit() {
    const r = this.els.stage.getBoundingClientRect();
    const sw = r.width || 1, sh = r.height || 1;
    this.view.base = Math.min(sw / this.width, sh / this.height);
    this.view.zoom = 1;
    this.view.tx = (sw - this.width * this.view.base) / 2;
    this.view.ty = (sh - this.height * this.view.base) / 2;
    this.applyView();
  }

  // Amplía para que la zona con texto ocupe la pantalla (las etiquetas suelen ser pequeñas en la foto).
  zoomToText() {
    if (!this.words.length) return;
    const xs0 = this.words.map((w) => w.x0), ys0 = this.words.map((w) => w.y0);
    const xs1 = this.words.map((w) => w.x1), ys1 = this.words.map((w) => w.y1);
    const h = Math.max(...this.words.map((w) => w.y1 - w.y0));
    const x0 = Math.max(0, Math.min(...xs0) - h), y0 = Math.max(0, Math.min(...ys0) - h);
    const x1 = Math.min(this.width, Math.max(...xs1) + h), y1 = Math.min(this.height, Math.max(...ys1) + h);
    const r = this.els.stage.getBoundingClientRect();
    const v = this.view;
    const want = Math.min(r.width / (x1 - x0), r.height / (y1 - y0));
    const zoom = Math.min(4, Math.max(1, want / v.base));
    if (zoom < 1.15) return;
    v.zoom = zoom;
    const s = v.base * zoom;
    v.tx = r.width / 2 - ((x0 + x1) / 2) * s;
    v.ty = r.height / 2 - ((y0 + y1) / 2) * s;
    this.clamp();
    this.applyView();
  }

  zoomBy(factor, cx, cy) {
    const r = this.els.stage.getBoundingClientRect();
    if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
    const v = this.view;
    const oldS = v.base * v.zoom;
    const zoom = Math.min(MAX_SCALE, Math.max(1, v.zoom * factor));
    const s = v.base * zoom;
    // Mantener fijo el punto (cx, cy) de la pantalla.
    v.tx = cx - (cx - v.tx) * (s / oldS);
    v.ty = cy - (cy - v.ty) * (s / oldS);
    v.zoom = zoom;
    this.clamp();
    this.applyView();
  }

  clamp() {
    const r = this.els.stage.getBoundingClientRect();
    const v = this.view;
    const s = v.base * v.zoom;
    const w = this.width * s, h = this.height * s;
    v.tx = w <= r.width ? (r.width - w) / 2 : Math.min(0, Math.max(r.width - w, v.tx));
    v.ty = h <= r.height ? (r.height - h) / 2 : Math.min(0, Math.max(r.height - h, v.ty));
  }

  applyView() {
    const v = this.view;
    this.els.wrap.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.base * v.zoom})`;
  }

  // --- Render ------------------------------------------------------------------
  renderAll() {
    this.renderChips(true);
    this.renderOverlay();
    this.renderActive();
  }

  renderChips(scroll) {
    const { chips, noFieldsHint, activeRow, progress } = this.els;
    const fields = this.fields;
    const frag = document.createDocumentFragment();
    fields.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(f === this.active));
      b.style.setProperty('--c', colorFor(fields, f));
      b.dataset.field = f;
      const name = document.createElement('span');
      name.className = 'chip-name';
      name.textContent = f;
      const val = document.createElement('span');
      val.className = 'chip-val';
      const v = this.valueOf(f).trim();
      const conf = this.confOf(f);
      const doubt = v && conf != null && conf < DOUBT_CONF && !this.pending.has(f);
      const ok = v && this.isVerified(f);
      val.textContent = (ok ? '✓ ' : doubt ? '⚠ ' : '') + (v || '—');
      if (ok) b.classList.add('verified');
      if (v) b.classList.add('filled');
      if (this.pending.has(f)) b.classList.add('pending');
      if (doubt) b.classList.add('doubt');
      b.append(name, val);
      frag.appendChild(b);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip chip-add';
    add.dataset.add = '1';
    add.textContent = '+ Campo';
    frag.appendChild(add);
    chips.replaceChildren(frag);
    noFieldsHint.hidden = fields.length > 0;
    activeRow.hidden = fields.length === 0;
    progress.textContent = fields.length ? `${this.filledCount()} de ${fields.length} campos` : '';
    if (scroll) {
      const el = chips.querySelector('[aria-checked="true"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  }

  renderActive() {
    const { activeLabel, activeInput, activeNext, activeHint } = this.els;
    const f = this.active;
    const type = f ? this.opts.getType(f) : 'texto';
    activeLabel.textContent = f ? (type !== 'texto' ? `${f} · ${FIELD_TYPES[type].short}` : f) : '';
    if (activeHint) {
      const v = f ? this.valueOf(f).trim() : '';
      const conf = f ? this.confOf(f) : null;
      if (f && this.pending.has(f)) { activeHint.textContent = 'Releyendo con más precisión…'; activeHint.className = 'active-hint busy'; }
      else if (v && this.isVerified(f)) { activeHint.textContent = '✓ Verificado con el código de barras de la etiqueta'; activeHint.className = 'active-hint ok'; }
      else if (v && conf != null && conf < DOUBT_CONF) { activeHint.textContent = 'Lectura dudosa: compárala con la foto y corrígela si hace falta.'; activeHint.className = 'active-hint warn'; }
      else { activeHint.textContent = ''; activeHint.className = 'active-hint'; }
    }
    activeLabel.style.color = f ? colorFor(this.fields, f) : '';
    if (document.activeElement !== activeInput) activeInput.value = f ? this.valueOf(f) : '';
    const last = this.fields.indexOf(f) === this.fields.length - 1;
    activeNext.setAttribute('aria-label', last ? 'Terminar' : 'Siguiente campo');
  }

  renderOverlay() {
    const fields = this.fields;
    const frag = document.createDocumentFragment();
    this.words.forEach((w, i) => {
      if (w.hidden) return;
      const r = document.createElementNS(SVG_NS, 'rect');
      const pad = 3;
      r.setAttribute('x', w.x0 - pad);
      r.setAttribute('y', w.y0 - pad);
      r.setAttribute('width', Math.max(1, w.x1 - w.x0 + pad * 2));
      r.setAttribute('height', Math.max(1, w.y1 - w.y0 + pad * 2));
      r.setAttribute('rx', 4);
      const f = this.assign.get(i);
      if (f) {
        const c = colorFor(fields, f);
        r.setAttribute('class', w.bc ? 'w sel bc' : 'w sel');
        r.style.fill = c;
        r.style.fillOpacity = '0.38';
        r.style.stroke = c;
      } else {
        r.setAttribute('class', w.bc ? 'w bc' : (w.conf || 0) < LOW_WORD_CONF ? 'w low' : 'w');
      }
      frag.appendChild(r);
    });
    const g = this.gesture;
    if (g && g.type === 'marquee' && g.moved) {
      const m = document.createElementNS(SVG_NS, 'rect');
      const { x, y, w, h } = normRect(g.start, g.cur);
      m.setAttribute('class', 'marquee');
      m.setAttribute('x', x); m.setAttribute('y', y); m.setAttribute('width', w); m.setAttribute('height', h);
      frag.appendChild(m);
    }
    this.els.svg.replaceChildren(frag);
  }

  // --- Eventos -------------------------------------------------------------------
  _bind() {
    const { chips, stage, zoomIn, zoomOut, activeInput, activeClear, activeNext } = this.els;

    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      if (b.dataset.add) { this.opts.requestAddField(); return; }
      this.setActive(b.dataset.field);
    });
    zoomIn.addEventListener('click', () => this.zoomBy(1.6));
    zoomOut.addEventListener('click', () => this.zoomBy(1 / 1.6));
    activeInput.addEventListener('input', () => { this.setManual(activeInput.value); this.renderActive(); });
    activeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (!this.next()) activeInput.blur(); }
    });
    activeClear.addEventListener('click', () => this.clearActive());
    activeNext.addEventListener('click', () => {
      if (!this.next()) this.opts.onDone && this.opts.onDone();
    });
    window.addEventListener('resize', () => { if (this.words.length || this.els.img.getAttribute('src')) { this.clamp(); this.applyView(); } });

    // Coordenadas de pantalla → imagen.
    const toImg = (cx, cy) => {
      const r = this.els.svg.getBoundingClientRect();
      return { x: (cx - r.left) * (this.width / (r.width || 1)), y: (cy - r.top) * (this.height / (r.height || 1)), sx: cx, sy: cy, scale: this.width / (r.width || 1) };
    };
    const stageXY = (cx, cy) => { const r = stage.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; };

    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignorar */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) {
        this.gesture = { type: 'marquee', id: e.pointerId, start: toImg(e.clientX, e.clientY), cur: null, moved: false };
        this.gesture.cur = this.gesture.start;
      } else if (this.pointers.size === 2) {
        // Empieza el pellizco: se cancela cualquier selección.
        const [a, b] = [...this.pointers.values()];
        const mid = stageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
        this.gesture = {
          type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom0: this.view.zoom,
          mid0: mid, tx0: this.view.tx, ty0: this.view.ty,
        };
        this.renderOverlay();
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = this.gesture;
      if (!g) return;
      if (g.type === 'pinch' && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mid = stageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
        const v = this.view;
        const zoom = Math.min(MAX_SCALE, Math.max(1, g.zoom0 * d / g.d0));
        const k = zoom / g.zoom0;
        v.zoom = zoom;
        v.tx = mid.x - (g.mid0.x - g.tx0) * k;
        v.ty = mid.y - (g.mid0.y - g.ty0) * k;
        this.clamp();
        this.applyView();
      } else if (g.type === 'marquee' && g.id === e.pointerId) {
        g.cur = toImg(e.clientX, e.clientY);
        if (!g.moved && Math.hypot(g.cur.sx - g.start.sx, g.cur.sy - g.start.sy) > DRAG_PX) g.moved = true;
        if (g.moved) this.renderOverlay();
      }
    });
    const end = (e, cancelled) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const g = this.gesture;
      if (!g) return;
      if (g.type === 'pinch') {
        if (this.pointers.size === 0) this.gesture = null;
        return; // tras un pellizco no se selecciona nada hasta levantar todos los dedos
      }
      if (g.id !== e.pointerId) return;
      this.gesture = null;
      if (cancelled) { this.renderOverlay(); return; }
      if (g.moved) {
        const r = normRect(g.start, g.cur);
        const hits = [];
        this.words.forEach((w, i) => {
          const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
          if (!w.hidden && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) hits.push(i);
        });
        // Si el recuadro coge texto, se ignoran los códigos de barras (evita duplicar el dato).
        const textHits = hits.filter((i) => !this.words[i].bc);
        this.renderOverlay();
        this.toggleWords(textHits.length ? textHits : hits);
      } else {
        const i = this.hitTest(g.start.x, g.start.y, 12 * g.start.scale);
        if (i >= 0) this.toggleWords([i]);
      }
      this.els.hint.classList.add('fade');
    };
    stage.addEventListener('pointerup', (e) => end(e, false));
    stage.addEventListener('pointercancel', (e) => end(e, true));
    // Rueda / trackpad en escritorio.
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = stageXY(e.clientX, e.clientY);
      this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    }, { passive: false });
    // Safari iOS: evita su gesto de zoom de página dentro del lienzo.
    stage.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  hitTest(x, y, tol) {
    let best = -1;
    let bestD = Infinity;
    // Dentro de un código de barras, gana el código.
    const inBc = this.words.findIndex((w) => w.bc && x >= w.x0 && x <= w.x1 && y >= w.y0 && y <= w.y1);
    if (inBc >= 0) return inBc;
    this.words.forEach((w, i) => {
      if (w.hidden) return;
      const dx = x < w.x0 ? w.x0 - x : x > w.x1 ? x - w.x1 : 0;
      const dy = y < w.y0 ? w.y0 - y : y > w.y1 ? y - w.y1 : 0;
      const dist = Math.hypot(dx, dy);
      if (dist <= tol && dist < bestD) { best = i; bestD = dist; }
    });
    return best;
  }
}

function normRect(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function removeOnce(text, word) {
  const s = String(text || '');
  const i = s.indexOf(word);
  if (i < 0) return s;
  return (s.slice(0, i) + s.slice(i + word.length)).replace(/\s{2,}/g, ' ').trim();
}
