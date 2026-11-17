// Selección de campos sobre la imagen del OCR.
// El usuario define campos (columnas del CSV), elige uno y toca/arrastra sobre las palabras
// detectadas para asignarlas. El valor de cada campo se puede corregir a mano.

export const FIELD_COLORS = ['#0f766e', '#c2410c', '#7c3aed', '#2563eb', '#be185d', '#15803d', '#a16207', '#0e7490', '#b91c1c', '#4d7c0f'];
const RESERVED = ['fecha', 'tipo', 'formato', 'valor', 'nota'];
const SVG_NS = 'http://www.w3.org/2000/svg';
const DRAG_PX = 10;

export function colorFor(fields, name) {
  const i = fields.indexOf(name);
  return FIELD_COLORS[(i < 0 ? 0 : i) % FIELD_COLORS.length];
}

export class FieldPicker {
  /**
   * @param {object} els  elementos del DOM
   * @param {object} opts { getFields(): string[], setFields(string[]), toast(msg) }
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
    this.editMode = false;
    this.zoomed = false;
    this.drag = null;
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
    this.editMode = false;
    this.setZoom(false);
    if (!this.fields.includes(this.active)) this.active = this.fields[0] || null;
    if (imgUrl) this.els.img.src = imgUrl;
    this.els.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.els.svg.setAttribute('preserveAspectRatio', 'none');
    // Sin ampliar, la imagen entera cabe en el alto disponible.
    this.els.wrap.style.maxWidth = `calc(60vh * ${(this.width / this.height).toFixed(4)})`;
    this.renderAll();
  }

  reset() {
    this.words = [];
    this.assign.clear();
    this.manual.clear();
    this.els.svg.replaceChildren();
    this.els.values.replaceChildren();
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

  valueOf(field) {
    if (this.manual.has(field)) return this.manual.get(field);
    const parts = [];
    this.words.forEach((w, i) => { if (this.assign.get(i) === field) parts.push(w.text); });
    return parts.join(' ');
  }

  // --- Campos ----------------------------------------------------------------
  addField(name) {
    const n = String(name || '').replace(/\s+/g, ' ').trim();
    if (!n) return false;
    const lower = n.toLowerCase();
    if (RESERVED.includes(lower)) { this.opts.toast(`«${n}» ya es una columna del CSV. Usa otro nombre.`); return false; }
    if (this.fields.some((f) => f.toLowerCase() === lower)) { this.opts.toast(`El campo «${n}» ya existe.`); this.active = this.fields.find((f) => f.toLowerCase() === lower); this.renderAll(); return false; }
    this.opts.setFields([...this.fields, n]);
    this.active = n;
    this.renderAll();
    return true;
  }

  removeField(name) {
    this.opts.setFields(this.fields.filter((f) => f !== name));
    for (const [i, f] of [...this.assign]) if (f === name) this.assign.delete(i);
    this.manual.delete(name);
    if (this.active === name) this.active = this.fields[0] || null;
    if (!this.fields.length) this.editMode = false;
    this.renderAll();
  }

  setActive(name) {
    if (this.active === name) return;
    this.active = name;
    this.renderChips();
    this.renderValues(false);
  }

  setZoom(on) {
    this.zoomed = !!on;
    this.els.stage.classList.toggle('zoomed', this.zoomed);
    this.els.zoomBtn.setAttribute('aria-pressed', String(this.zoomed));
    this.els.zoomBtn.textContent = this.zoomed ? 'Reducir' : 'Ampliar';
    this.els.stageHint.textContent = this.zoomed
      ? 'Desliza para moverte y toca las palabras.'
      : 'Toca una palabra o arrastra un recuadro para seleccionar varias.';
  }

  // --- Asignación ------------------------------------------------------------
  _ensureActive() {
    if (!this.fields.length) {
      this.opts.toast('Primero crea un campo (p. ej. «Total»).');
      this.showAddForm();
      return false;
    }
    if (!this.active) this.active = this.fields[0];
    return true;
  }

  toggleWords(indices) {
    if (!indices.length || !this._ensureActive()) return;
    const f = this.active;
    const allMine = indices.every((i) => this.assign.get(i) === f);
    const ordered = [...indices].sort((a, b) => a - b);
    for (const i of ordered) {
      if (allMine) {
        this.assign.delete(i);
        if (this.manual.has(f)) this.manual.set(f, removeOnce(this.manual.get(f), this.words[i].text));
      } else if (this.assign.get(i) !== f) {
        const prev = this.assign.get(i);
        if (prev && this.manual.has(prev)) this.manual.set(prev, removeOnce(this.manual.get(prev), this.words[i].text));
        this.assign.set(i, f);
        if (this.manual.has(f)) this.manual.set(f, (this.manual.get(f) + ' ' + this.words[i].text).trim());
      }
    }
    this.renderOverlay();
    this.renderValues(false);
  }

  // --- Render ------------------------------------------------------------------
  renderAll() {
    this.renderChips();
    this.renderOverlay();
    this.renderValues(true);
  }

  renderChips() {
    const { chips, noFieldsHint, editBtn, help } = this.els;
    const fields = this.fields;
    const frag = document.createDocumentFragment();
    fields.forEach((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(!this.editMode && f === this.active));
      b.style.setProperty('--c', colorFor(fields, f));
      b.dataset.field = f;
      b.append(document.createTextNode(f));
      if (this.editMode) {
        const x = document.createElement('span');
        x.className = 'chip-x';
        x.textContent = '✕';
        b.append(x);
        b.setAttribute('aria-label', `Quitar campo ${f}`);
      }
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
    editBtn.hidden = fields.length === 0;
    editBtn.textContent = this.editMode ? 'Listo' : 'Editar campos';
    editBtn.setAttribute('aria-pressed', String(this.editMode));
    help.textContent = this.editMode
      ? 'Toca ✕ para quitar un campo de la lista.'
      : fields.length ? '1. Elige un campo · 2. Toca las palabras en la foto' : 'Crea los campos que quieres extraer';
    help.hidden = !fields.length;
  }

  renderOverlay() {
    const svg = this.els.svg;
    const fields = this.fields;
    const frag = document.createDocumentFragment();
    this.words.forEach((w, i) => {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', w.x0 - 2);
      r.setAttribute('y', w.y0 - 2);
      r.setAttribute('width', Math.max(1, w.x1 - w.x0 + 4));
      r.setAttribute('height', Math.max(1, w.y1 - w.y0 + 4));
      r.setAttribute('rx', 3);
      const f = this.assign.get(i);
      if (f) {
        const c = colorFor(fields, f);
        r.setAttribute('class', 'w sel');
        r.style.fill = c;
        r.style.fillOpacity = '0.35';
        r.style.stroke = c;
      } else {
        r.setAttribute('class', 'w');
      }
      frag.appendChild(r);
    });
    if (this.drag && this.drag.moved) {
      const m = document.createElementNS(SVG_NS, 'rect');
      const { x, y, w, h } = normRect(this.drag.start, this.drag.cur);
      m.setAttribute('class', 'marquee');
      m.setAttribute('x', x); m.setAttribute('y', y); m.setAttribute('width', w); m.setAttribute('height', h);
      frag.appendChild(m);
    }
    svg.replaceChildren(frag);
  }

  // rebuild=false → actualiza valores sin recrear los inputs (no se pierde el foco).
  renderValues(rebuild) {
    const box = this.els.values;
    const fields = this.fields;
    if (!rebuild && box.children.length === fields.length) {
      [...box.children].forEach((row) => {
        const f = row.dataset.field;
        row.classList.toggle('active', f === this.active);
        const input = row.querySelector('input');
        if (document.activeElement !== input) input.value = this.valueOf(f);
      });
      return;
    }
    const frag = document.createDocumentFragment();
    fields.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'fv' + (f === this.active ? ' active' : '');
      row.dataset.field = f;
      row.style.setProperty('--c', colorFor(fields, f));
      const label = document.createElement('label');
      label.className = 'fv-label';
      const id = 'fv-' + Math.random().toString(36).slice(2, 8);
      label.htmlFor = id;
      label.textContent = f;
      const line = document.createElement('div');
      line.className = 'fv-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = 'Toca palabras en la foto o escribe';
      input.value = this.valueOf(f);
      input.addEventListener('focus', () => this.setActive(f));
      input.addEventListener('input', () => { this.manual.set(f, input.value); });
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn-secondary fv-clear';
      clear.setAttribute('aria-label', `Vaciar ${f}`);
      clear.textContent = '✕';
      clear.addEventListener('click', () => {
        for (const [i, ff] of [...this.assign]) if (ff === f) this.assign.delete(i);
        this.manual.delete(f);
        input.value = '';
        this.setActive(f);
        this.renderOverlay();
      });
      line.append(input, clear);
      row.append(label, line);
      frag.appendChild(row);
    });
    box.replaceChildren(frag);
  }

  showAddForm() {
    this.els.addForm.hidden = false;
    this.els.addInput.value = '';
    this.els.addInput.focus();
  }

  // --- Eventos -------------------------------------------------------------------
  _bind() {
    const { chips, editBtn, addForm, addInput, addCancel, svg, zoomBtn } = this.els;

    chips.addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      if (b.dataset.add) { this.showAddForm(); return; }
      if (this.editMode) this.removeField(b.dataset.field);
      else this.setActive(b.dataset.field);
    });
    editBtn.addEventListener('click', () => { this.editMode = !this.editMode; this.renderChips(); });
    addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.addField(addInput.value)) { addForm.hidden = true; addInput.blur(); }
    });
    addCancel.addEventListener('click', () => { addForm.hidden = true; });
    zoomBtn.addEventListener('click', () => this.setZoom(!this.zoomed));

    const toImg = (e) => {
      const r = svg.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (this.width / (r.width || 1)),
        y: (e.clientY - r.top) * (this.height / (r.height || 1)),
        sx: e.clientX, sy: e.clientY, scale: this.width / (r.width || 1),
      };
    };

    svg.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const p = toImg(e);
      this.drag = { id: e.pointerId, start: p, cur: p, moved: false };
      if (!this.zoomed) { try { svg.setPointerCapture(e.pointerId); } catch { /* ignorar */ } }
    });
    svg.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      d.cur = toImg(e);
      if (!d.moved && Math.hypot(d.cur.sx - d.start.sx, d.cur.sy - d.start.sy) > DRAG_PX) {
        if (this.zoomed) { this.drag = null; return; } // en modo ampliado, arrastrar = desplazarse
        d.moved = true;
      }
      if (d.moved) { e.preventDefault(); this.renderOverlay(); }
    });
    const end = (e, cancelled) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      if (cancelled) { this.renderOverlay(); return; }
      if (d.moved) {
        const r = normRect(d.start, d.cur);
        const hits = [];
        this.words.forEach((w, i) => {
          const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
          if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) hits.push(i);
        });
        this.renderOverlay();
        this.toggleWords(hits);
      } else {
        const i = this.hitTest(d.start.x, d.start.y, 10 * d.start.scale);
        if (i >= 0) this.toggleWords([i]);
      }
    };
    svg.addEventListener('pointerup', (e) => end(e, false));
    svg.addEventListener('pointercancel', (e) => end(e, true));
  }

  hitTest(x, y, tol) {
    let best = -1;
    let bestD = Infinity;
    this.words.forEach((w, i) => {
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
