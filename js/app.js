// ScannerCSV — lógica principal (interfaz móvil con pestañas).
import { db, newId, requestPersistence, storageEstimate } from './db.js';
import { buildCsv, csvFileName, exportCsv, formatLabel, formatDate } from './csv.js';
import { Camera } from './camera.js';
import * as ocr from './ocr.js';
import { FieldPicker, colorFor, validateFieldName } from './fields.js';
import { FIELD_TYPES, guessType } from './fieldtypes.js';
import { refineWords } from './refine.js';
import { grayStretch, sharpness, rotateCanvas } from './preprocess.js';

const APP_VERSION = '2.1.0-dev';
const SOURCE_SIDE = 3000; // lado largo máximo de la imagen original guardada para releer campos
const PSM_BY_DOC = { etiqueta: '11', documento: '3' }; // texto disperso / página normal
const MAX_RENDERED = 400;
const SCAN_SIDE = 800; // lado largo de la región enviada al lector de códigos
const COOLDOWN_MS = 2500;
const LAST_SCAN_MS = 6000;
const FIELD_SUGGESTIONS = ['Nº factura', 'Nº albarán', 'Fecha', 'Proveedor', 'Cliente', 'NIF', 'Base', 'IVA', 'Total', 'Referencia', 'Lote', 'Caducidad', 'Cantidad', 'Peso'];

const $ = (id) => document.getElementById(id);
const els = {
  body: document.body,
  tabs: [...document.querySelectorAll('.tab')],
  screens: { scan: $('tabScan'), list: $('tabList'), settings: $('tabSettings') },
  tabBadge: $('tabBadge'), settingsDot: $('settingsDot'),
  // cámara
  video: $('video'), viewport: $('viewport'), frame: $('frame'), flash: $('flash'), focusRing: $('focusRing'),
  placeholderText: $('placeholderText'), camHint: $('camHint'), cameraBtn: $('cameraBtn'), insecureNotice: $('insecureNotice'),
  shutterBtn: $('shutterBtn'), shutterIcon: $('shutterIcon'), torchBtn: $('torchBtn'), switchCamBtn: $('switchCamBtn'), switchSpacer: $('switchSpacer'),
  fileInput: $('fileInput'), modeBarcode: $('modeBarcode'), modeOcr: $('modeOcr'),
  lastScan: $('lastScan'), lastScanFormat: $('lastScanFormat'), lastScanValue: $('lastScanValue'), lastScanUndo: $('lastScanUndo'),
  // lista
  list: $('list'), count: $('count'), emptyList: $('emptyList'), noResults: $('noResults'), searchInput: $('searchInput'),
  addManualBtn: $('addManualBtn'), emptyGoScan: $('emptyGoScan'), listNotices: $('listNotices'),
  exportBtn: $('exportBtn'), downloadBtn: $('downloadBtn'), clearBtn: $('clearBtn'),
  // ajustes
  settingsNotices: $('settingsNotices'), installCard: $('installCard'), installBtn: $('installBtn'),
  fieldList: $('fieldList'), settingsAddField: $('settingsAddField'),
  setSep: $('setSep'), setProtect: $('setProtect'), setLang: $('setLang'), setDedupe: $('setDedupe'), setBeep: $('setBeep'),
  prefetchOcr: $('prefetchOcr'), prefetchStatus: $('prefetchStatus'), storageInfo: $('storageInfo'), appVersion: $('appVersion'),
  // editor
  editor: $('editor'), edCancel: $('edCancel'), edSave: $('edSave'), edTitle: $('edTitle'),
  ocrProgress: $('ocrProgress'), ocrStatus: $('ocrStatus'), ocrPct: $('ocrPct'), ocrBar: $('ocrBar'), ocrFill: $('ocrFill'), ocrCancel: $('ocrCancel'),
  edPanel: $('edPanel'), fullTextBtn: $('fullTextBtn'), ocrPreviewImg: $('ocrPreview'),
  textDialog: $('textDialog'), ocrText: $('ocrText'),
  // diálogos
  editDialog: $('editDialog'), editTitle: $('editTitle'), editValue: $('editValue'), editValueField: $('editValueField'),
  editFields: $('editFields'), editNote: $('editNote'), editMeta: $('editMeta'), editDelete: $('editDelete'),
  fieldDialog: $('fieldDialog'), fieldForm: $('fieldForm'), fieldNameInput: $('fieldNameInput'), fieldSuggest: $('fieldSuggest'),
  fieldTypeSelect: $('fieldTypeSelect'), setDocType: $('setDocType'),
  confirmDialog: $('confirmDialog'), confirmText: $('confirmText'), confirmOk: $('confirmOk'),
  toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
};

// --- Plataforma -------------------------------------------------------------------
const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Instagram|FBAN|FBAV/.test(ua);
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const canUseCamera = () => window.isSecureContext && Camera.isSupported();

const safeLocal = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
};

// --- Estado -------------------------------------------------------------------------
const state = {
  tab: 'scan',
  mode: 'barcode',
  paused: false,
  records: [],
  query: '',
  settings: { sep: ';', protect: true, lang: 'spa', dedupe: false, beep: true, fields: [], fieldTypes: {}, docType: 'etiqueta' },
  lastHit: { text: '', at: 0 },
  lastSaved: null,
  newIds: new Set(),
  wantCamera: safeLocal.get('camOn') === '1',
};

const camera = new Camera(els.video);
let scanTimer = null;
let scanPending = false;
let scanPendingSince = 0;
let scanReqId = 0;
const scanCanvas = document.createElement('canvas');
let barcodeWorker = null;
const stillRequests = new Map();

const picker = new FieldPicker({
  chips: $('fieldChips'), noFieldsHint: $('noFieldsHint'), activeRow: $('activeRow'), activeLabel: $('activeLabel'),
  activeInput: $('activeInput'), activeClear: $('activeClear'), activeNext: $('activeNext'), progress: $('fieldsProgress'),
  activeHint: $('activeHint'),
  stage: $('ocrStage'), wrap: $('ocrCanvasWrap'), img: $('ocrPreview'), svg: $('ocrOverlay'),
  zoomIn: $('zoomIn'), zoomOut: $('zoomOut'), hint: $('stageHint'),
}, {
  getFields: () => state.settings.fields,
  getType: (f) => fieldType(f),
  refine: (field, indices) => refineWords(els.ocrPreviewImg, els.ocrPreviewImg.naturalWidth, picker.width, picker.words, indices,
    { type: fieldType(field), lang: state.settings.lang }),
  toast: (m) => toast(m, { ms: 3500 }),
  requestAddField: () => addFieldFlow(),
  onDone: () => els.edSave.focus(),
});

// --- Utilidades UI -----------------------------------------------------------------------
let toastTimer = null;
function toast(text, { action, onAction, ms = 3000 } = {}) {
  clearTimeout(toastTimer);
  els.toastText.textContent = text;
  if (action) {
    els.toastAction.textContent = action;
    els.toastAction.hidden = false;
    els.toastAction.onclick = () => { hideToast(); onAction && onAction(); };
  } else {
    els.toastAction.hidden = true;
    els.toastAction.onclick = null;
  }
  els.toast.hidden = false;
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { els.toast.hidden = true; }

const hasDialog = (d) => d && typeof d.showModal === 'function';

function openSheet(d) {
  return new Promise((resolve) => {
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue), { once: true });
    d._openedAt = Date.now();
    d.showModal();
  });
}

function confirmAsk(text, okLabel = 'Borrar') {
  if (!hasDialog(els.confirmDialog)) return Promise.resolve(window.confirm(text));
  els.confirmText.textContent = text;
  els.confirmOk.textContent = okLabel;
  return openSheet(els.confirmDialog).then((v) => v === 'ok');
}

let audioCtx = null;
function unlockAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { audioCtx = null; }
}
function beep() {
  if (!state.settings.beep || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 1760;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.13);
  } catch { /* sin sonido */ }
}
function vibrate(ms) {
  // Vibration API: no existe en Safari iOS.
  if (typeof navigator.vibrate === 'function') { try { navigator.vibrate(ms); } catch { /* ignorar */ } }
}
function flash() {
  els.flash.classList.remove('on');
  void els.flash.offsetWidth;
  els.flash.classList.add('on');
  els.frame.classList.add('hit');
  setTimeout(() => els.frame.classList.remove('hit'), 600);
}
const truncate = (s, n) => { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// --- Pestañas --------------------------------------------------------------------------------
function setTab(tab) {
  if (state.tab === tab) return;
  const prev = state.tab;
  state.tab = tab;
  els.body.dataset.tab = tab;
  Object.entries(els.screens).forEach(([k, el]) => { el.hidden = k !== tab; });
  els.tabs.forEach((t) => {
    if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  updateThemeColor();
  if (prev === 'scan' && tab !== 'scan') pauseCameraForAway();
  if (tab === 'scan') resumeCameraIfWanted();
  if (tab === 'list') { state.newIds.clear(); }
}

function updateThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const c = state.tab === 'scan' || els.body.classList.contains('editing')
    ? '#000000'
    : getComputedStyle(els.body).backgroundColor;
  meta.setAttribute('content', c);
}

// --- Registros -----------------------------------------------------------------------------------
async function addRecords(recs, { announce = true } = {}) {
  if (!recs.length) return false;
  try {
    await db.putRecords(recs);
  } catch (err) {
    console.error(err);
    toast('No se pudo guardar: ' + (err && err.message || err), { ms: 5000 });
    return false;
  }
  state.records = [...recs].reverse().concat(state.records);
  recs.forEach((r) => state.newIds.add(r.id));
  renderList();
  if (announce) {
    const label = recs.length === 1 ? 'Guardado' : `${recs.length} filas guardadas`;
    toast(label, { action: 'Deshacer', onAction: () => removeRecords(recs.map((r) => r.id)), ms: 3500 });
  }
  return true;
}

async function removeRecords(ids) {
  try {
    for (const id of ids) await db.deleteRecord(id);
  } catch (err) {
    toast('No se pudo borrar: ' + (err && err.message || err));
  }
  const set = new Set(ids);
  state.records = state.records.filter((r) => !set.has(r.id));
  renderList();
}

function recordText(r) {
  if (r.fields) return Object.entries(r.fields).map(([k, v]) => `${k} ${v}`).join(' ') + ' ' + (r.note || '');
  return `${r.value} ${r.note || ''} ${formatLabel(r.format)}`;
}

function renderList() {
  const all = state.records;
  const q = state.query.trim().toLowerCase();
  const recs = q ? all.filter((r) => recordText(r).toLowerCase().includes(q)) : all;
  els.count.textContent = String(all.length);
  els.tabBadge.textContent = all.length > 999 ? '999+' : String(all.length);
  els.tabBadge.hidden = all.length === 0;
  els.emptyList.hidden = all.length > 0;
  els.noResults.hidden = !(all.length && !recs.length);
  els.searchInput.parentElement.hidden = all.length === 0;

  const frag = document.createDocumentFragment();
  recs.slice(0, MAX_RENDERED).forEach((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item' + (state.newIds.has(r.id) ? ' new' : '');
    b.dataset.id = r.id;
    const tag = document.createElement('span');
    const main = document.createElement('span');
    main.className = 'item-main';
    const val = document.createElement('span');
    val.className = 'item-value';
    if (r.fields && Object.keys(r.fields).length) {
      tag.className = 'item-tag doc';
      tag.textContent = 'DOC';
      val.classList.add('item-fields');
      Object.entries(r.fields).forEach(([k, v], i) => {
        if (i) val.append(' · ');
        const kb = document.createElement('b');
        kb.textContent = k + ': ';
        val.append(kb, v);
      });
    } else {
      tag.className = 'item-tag' + (r.type === 'ocr' ? ' ocr' : '');
      tag.textContent = r.type === 'ocr' ? 'TXT' : formatLabel(r.format);
      val.textContent = r.value;
    }
    const meta = document.createElement('span');
    meta.className = 'item-meta';
    meta.textContent = formatDate(r.createdAt) + (r.note ? ' · ' + r.note : '');
    main.append(val, meta);
    b.append(tag, main);
    li.appendChild(b);
    frag.appendChild(li);
  });
  if (recs.length > MAX_RENDERED) {
    const li = document.createElement('li');
    li.className = 'list-more';
    li.textContent = `Se muestran ${MAX_RENDERED} de ${recs.length}. Usa la búsqueda; el CSV incluye todos.`;
    frag.appendChild(li);
  }
  els.list.replaceChildren(frag);
  if (state.tab === 'list') state.newIds.clear();
}

// --- Edición de un registro ---------------------------------------------------------------------
function openEdit(rec) {
  const isNew = !rec;
  if (!hasDialog(els.editDialog)) {
    const v = window.prompt(isNew ? 'Valor' : 'Editar valor', rec ? rec.value : '');
    if (v == null || !v.trim()) return;
    if (isNew) addRecords([{ id: newId(), type: 'manual', format: 'MANUAL', value: v.trim(), note: '', createdAt: Date.now() }]);
    else { rec.value = v.trim(); db.putRecord(rec).then(renderList); }
    return;
  }
  const hasFields = !!(rec && rec.fields && Object.keys(rec.fields).length);
  els.editTitle.textContent = isNew ? 'Añadir a mano' : hasFields ? 'Editar documento' : 'Editar escaneo';
  els.editValue.value = rec ? rec.value : '';
  els.editValueField.hidden = hasFields;
  els.editFields.replaceChildren();
  const fieldInputs = {};
  if (hasFields) {
    Object.entries(rec.fields).forEach(([k, v]) => {
      const label = document.createElement('label');
      label.className = 'field';
      const span = document.createElement('span');
      span.textContent = k;
      const input = document.createElement('input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.value = v;
      label.append(span, input);
      els.editFields.appendChild(label);
      fieldInputs[k] = input;
    });
  }
  els.editNote.value = rec ? (rec.note || '') : '';
  els.editMeta.textContent = rec ? `${formatLabel(rec.format)} · ${formatDate(rec.createdAt)}` : '';
  els.editDelete.hidden = isNew;
  openSheet(els.editDialog).then(async (action) => {
    if (action === 'save') {
      const note = els.editNote.value.trim();
      let updated;
      if (hasFields) {
        const fields = {};
        Object.entries(fieldInputs).forEach(([k, input]) => { const v = input.value.trim(); if (v) fields[k] = v; });
        if (!Object.keys(fields).length) { toast('Todos los campos están vacíos: no se ha guardado.', { ms: 4000 }); return; }
        updated = { ...rec, fields, note };
      } else {
        const value = els.editValue.value.trim();
        if (!value) { toast('El valor está vacío: no se ha guardado.'); return; }
        if (isNew) {
          await addRecords([{ id: newId(), type: 'manual', format: 'MANUAL', value, note, createdAt: Date.now() }], { announce: false });
          toast('Añadido');
          return;
        }
        updated = { ...rec, value, note };
      }
      try {
        await db.putRecord(updated);
        state.records = state.records.map((r) => (r.id === rec.id ? updated : r));
        renderList();
      } catch { toast('No se pudo guardar'); }
    } else if (action === 'delete' && rec) {
      await removeRecords([rec.id]);
      toast('Eliminado', { action: 'Deshacer', onAction: () => addRecords([rec], { announce: false }) });
    }
  });
  if (isNew) setTimeout(() => els.editValue.focus(), 50);
}

// --- Campos (definición) -----------------------------------------------------------------------
function fieldType(f) {
  const t = state.settings.fieldTypes && state.settings.fieldTypes[f];
  return FIELD_TYPES[t] ? t : 'texto';
}

function setFieldType(f, type) {
  state.settings.fieldTypes = { ...(state.settings.fieldTypes || {}), [f]: type };
  saveSettings();
}

function setFields(fields) {
  state.settings.fields = fields;
  saveSettings();
  renderFieldList();
}

function renderFieldList() {
  const fields = state.settings.fields;
  const frag = document.createDocumentFragment();
  fields.forEach((f) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorFor(fields, f);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f;
    const sel = document.createElement('select');
    sel.className = 'row-select type-select';
    sel.dataset.typeFor = f;
    sel.setAttribute('aria-label', `Tipo del campo ${f}`);
    Object.entries(FIELD_TYPES).forEach(([k, v]) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = v.short;
      sel.appendChild(o);
    });
    sel.value = fieldType(f);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.dataset.remove = f;
    del.setAttribute('aria-label', `Quitar campo ${f}`);
    del.innerHTML = '<svg width="20" height="20" aria-hidden="true"><use href="#i-trash"/></svg>';
    li.append(dot, name, sel, del);
    frag.appendChild(li);
  });
  els.fieldList.replaceChildren(frag);
}

// Pide un nombre de campo (hoja inferior con sugerencias). Devuelve el nombre o null.
function askFieldName() {
  const input = els.fieldNameInput;
  input.value = '';
  input.setCustomValidity('');
  els.fieldTypeSelect.value = 'texto';
  els.fieldTypeSelect.dataset.touched = '';
  const existing = state.settings.fields.map((f) => f.toLowerCase());
  els.fieldSuggest.replaceChildren(...FIELD_SUGGESTIONS
    .filter((s) => !existing.includes(s.toLowerCase()))
    .slice(0, 8)
    .map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.addEventListener('click', () => { input.value = s; input.setCustomValidity(''); syncTypeGuess(); input.focus(); });
      return b;
    }));
  if (!hasDialog(els.fieldDialog)) {
    const v = window.prompt('Nombre del campo');
    const r = validateFieldName(v, state.settings.fields);
    if (r.error) { if (v) toast(r.error); return Promise.resolve(null); }
    return Promise.resolve({ name: r.name, type: guessType(r.name) });
  }
  setTimeout(() => input.focus(), 60);
  return openSheet(els.fieldDialog).then((v) => {
    if (v !== 'ok') return null;
    const r = validateFieldName(input.value, state.settings.fields);
    if (r.error) return null;
    return { name: r.name, type: els.fieldTypeSelect.value };
  });
}

// Propone el tipo según el nombre, salvo que el usuario ya lo haya elegido.
function syncTypeGuess() {
  if (els.fieldTypeSelect.dataset.touched) return;
  els.fieldTypeSelect.value = guessType(els.fieldNameInput.value);
}

async function addFieldFlow() {
  const res = await askFieldName();
  if (!res) return null;
  const { name, type } = res;
  setFieldType(name, type);
  setFields([...state.settings.fields, name]);
  picker.fieldsChanged(name);
  return name;
}

// --- Cámara -------------------------------------------------------------------------------------
function setCameraUi(running) {
  els.viewport.classList.toggle('live', running);
  els.viewport.classList.toggle('paused', running && state.paused && state.mode === 'barcode');
  els.torchBtn.hidden = !(running && camera.hasTorch);
  els.torchBtn.setAttribute('aria-pressed', String(running && camera.torchOn));
  const canSwitch = running && camera.canSwitch;
  els.switchCamBtn.hidden = !canSwitch;
  els.switchSpacer.hidden = canSwitch;
  updateShutter();
  updateHint();
}

function updateShutter() {
  const ocrMode = state.mode === 'ocr';
  els.shutterIcon.querySelector('use').setAttribute('href', state.paused ? '#i-play' : '#i-pause');
  els.shutterBtn.setAttribute('aria-label', ocrMode ? 'Capturar texto' : state.paused ? 'Reanudar escaneo' : 'Pausar escaneo');
}

function updateHint() {
  if (!camera.active) { els.camHint.textContent = ''; return; }
  const focus = camera.hasTapFocus ? ' · toca para enfocar' : '';
  if (state.mode === 'ocr') els.camHint.textContent = 'Encuadra el documento y pulsa el disparador' + focus;
  else if (state.paused) els.camHint.textContent = 'En pausa';
  else els.camHint.textContent = 'Apunta al código' + focus;
}

function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return isIOS
      ? 'Permiso de cámara denegado. Actívalo en Ajustes › Safari › Cámara (o en «aA» › Ajustes del sitio web).'
      : 'Permiso de cámara denegado. Actívalo desde el candado junto a la dirección.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró ninguna cámara.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'La cámara está ocupada por otra app. Ciérrala y vuelve a intentarlo.';
  return 'No se pudo iniciar la cámara' + (err && err.message ? `: ${err.message}` : '.');
}

let starting = false;
async function startCamera(deviceId) {
  if (!canUseCamera() || starting) return;
  starting = true;
  els.cameraBtn.disabled = true;
  els.placeholderText.textContent = 'Iniciando cámara…';
  try {
    await camera.start(deviceId, { highRes: state.mode === 'ocr' });
    // Si mientras arrancaba el usuario cambió de pestaña o abrió el editor, la paramos.
    if (state.tab !== 'scan' || els.body.classList.contains('editing') || document.visibilityState === 'hidden') {
      camera.stop();
      return;
    }
    state.wantCamera = true;
    safeLocal.set('camOn', '1');
    setCameraUi(true);
    if (state.mode === 'barcode') startScanLoop();
  } catch (err) {
    console.warn(err);
    camera.stop();
    setCameraUi(false);
    els.placeholderText.textContent = cameraErrorMessage(err);
    if (err && err.name === 'NotAllowedError') { state.wantCamera = false; safeLocal.set('camOn', '0'); }
  } finally {
    starting = false;
    els.cameraBtn.disabled = false;
  }
}

function pauseCameraForAway() {
  stopScanLoop();
  if (camera.active) camera.stop();
  setCameraUi(false);
  els.placeholderText.textContent = 'Activa la cámara para escanear códigos o texto.';
}

function resumeCameraIfWanted() {
  if (state.tab === 'scan' && state.wantCamera && !camera.active && !els.body.classList.contains('editing')
      && document.visibilityState === 'visible' && canUseCamera()) {
    startCamera();
  }
}

// --- Lectura de códigos -------------------------------------------------------------------------
function getBarcodeWorker() {
  if (barcodeWorker) return barcodeWorker;
  barcodeWorker = new Worker(new URL('./barcode-worker.js', import.meta.url));
  barcodeWorker.onmessage = (ev) => {
    const { id, result, error } = ev.data || {};
    if (stillRequests.has(id)) {
      const cb = stillRequests.get(id);
      stillRequests.delete(id);
      cb(error ? null : result);
      return;
    }
    scanPending = false;
    if (result && !state.paused && state.mode === 'barcode') onDetected(result);
  };
  barcodeWorker.onerror = (ev) => {
    console.error('barcode worker', ev);
    scanPending = false;
    els.camHint.textContent = 'Error en el lector de códigos.';
  };
  return barcodeWorker;
}

function startScanLoop() {
  stopScanLoop();
  getBarcodeWorker();
  const tick = () => {
    if (!camera.active || state.mode !== 'barcode') return;
    const v = els.video;
    if (scanPending && Date.now() - scanPendingSince > 3000) scanPending = false;
    if (!state.paused && !scanPending && v.readyState >= 2 && v.videoWidth > 0 && document.visibilityState === 'visible') {
      try {
        // Zona algo mayor que el marco visible: tolera códigos que sobresalen un poco.
        const fr = els.frame.getBoundingClientRect();
        const mx = fr.width * 0.12, my = fr.height * 0.25;
        const roi = camera.screenRectToVideo({ left: fr.left - mx, top: fr.top - my, width: fr.width + 2 * mx, height: fr.height + 2 * my });
        const c = camera.grab(roi, SCAN_SIDE, scanCanvas);
        const img = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
        scanPending = true;
        scanPendingSince = Date.now();
        barcodeWorker.postMessage({ id: ++scanReqId, width: img.width, height: img.height, buffer: img.data.buffer }, [img.data.buffer]);
      } catch (err) {
        console.warn('scan frame', err);
        scanPending = false;
      }
    }
    scanTimer = setTimeout(tick, 90);
  };
  tick();
}

function stopScanLoop() {
  clearTimeout(scanTimer);
  scanTimer = null;
  scanPending = false;
}

function decodeStill(canvas) {
  return new Promise((resolve) => {
    const w = getBarcodeWorker();
    const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    const id = ++scanReqId;
    stillRequests.set(id, resolve);
    w.postMessage({ id, width: img.width, height: img.height, buffer: img.data.buffer, still: true }, [img.data.buffer]);
  });
}

let lastScanTimer = null;
function showLastScan(rec) {
  state.lastSaved = rec;
  els.lastScanFormat.textContent = formatLabel(rec.format);
  els.lastScanValue.textContent = rec.value;
  els.lastScan.hidden = false;
  els.lastScan.style.animation = 'none';
  void els.lastScan.offsetWidth;
  els.lastScan.style.animation = '';
  clearTimeout(lastScanTimer);
  lastScanTimer = setTimeout(() => { els.lastScan.hidden = true; }, LAST_SCAN_MS);
}

async function onDetected(result, { fromPhoto = false } = {}) {
  const text = String(result.text || '');
  if (!text) return;
  const now = Date.now();
  if (!fromPhoto && text === state.lastHit.text && now - state.lastHit.at < COOLDOWN_MS) {
    state.lastHit.at = now;
    return;
  }
  state.lastHit = { text, at: now };
  flash();
  vibrate(60);
  beep();
  if (state.settings.dedupe && state.records.some((r) => r.value === text)) {
    toast(`Ya estaba en la lista: ${truncate(text, 32)}`);
    return;
  }
  const rec = { id: newId(), type: 'barcode', format: result.format || '', value: text, note: '', createdAt: now };
  if (await addRecords([rec], { announce: false })) showLastScan(rec);
}

// --- Editor OCR ---------------------------------------------------------------------------------------
let ocrToken = 0;
let previewUrl = null;
let editorPushed = false;
let editorOpen = false;

function openEditor() {
  editorOpen = true;
  els.editor.hidden = false;
  els.body.classList.add('editing');
  updateThemeColor();
  stopScanLoop();
  if (camera.active) camera.stop();
  setCameraUi(false);
  try { history.pushState({ editor: true }, ''); editorPushed = true; } catch { editorPushed = false; }
}

function closeEditor({ fromPop = false } = {}) {
  if (!editorOpen) return;
  editorOpen = false;
  ocrToken++;
  els.editor.hidden = true;
  els.body.classList.remove('editing');
  els.ocrText.value = '';
  picker.reset();
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  updateThemeColor();
  if (!fromPop && editorPushed) { editorPushed = false; try { history.back(); } catch { /* ignorar */ } }
  editorPushed = false;
  resumeCameraIfWanted();
}

async function confirmDiscardIfNeeded() {
  if (!picker.result()) return true;
  return confirmAsk('¿Descartar los datos seleccionados?', 'Descartar');
}

function setOcrProgress(p) {
  const pct = Math.round((p.progress || 0) * 100);
  els.ocrStatus.textContent = (p.status || 'Procesando') + '…';
  els.ocrPct.textContent = `${pct}%`;
  els.ocrFill.style.width = `${pct}%`;
  els.ocrBar.setAttribute('aria-valuenow', String(pct));
}

function canvasToBlob(c) {
  return new Promise((resolve) => {
    if (c.toBlob) c.toBlob((b) => resolve(b), 'image/jpeg', 0.93);
    else resolve(null);
  });
}

// sourceCanvas: imagen original (≤ SOURCE_SIDE px). Se detecta el texto en una copia de ≤1600 px
// (preprocesada) y cada campo se relee después desde la original, con más resolución.
async function runOcr(sourceCanvas) {
  const token = ++ocrToken;
  openEditor();
  els.ocrProgress.hidden = false;
  els.edSave.disabled = true;
  els.edPanel.hidden = true;
  setOcrProgress({ status: 'Preparando', progress: 0 });
  let source = sourceCanvas;
  let det = null;
  try {
    // Detección: ≤1600 px (también amplía fotos pequeñas) en grises con contraste estirado.
    det = ocr.scaleToSide(source, source.width, source.height, ocr.MAX_OCR_SIDE);
    grayStretch(det);
    const width = det.width, height = det.height;
    await setPreview(source);
    picker.preview({ imgUrl: previewUrl, width, height });
    const res = await ocr.recognize(det, state.settings.lang, (p) => { if (token === ocrToken) setOcrProgress(p); }, {
      params: { tessedit_pageseg_mode: PSM_BY_DOC[state.settings.docType] || '11', preserve_interword_spaces: '1', user_defined_dpi: '300' },
      rotateAuto: true,
    });
    if (token !== ocrToken) return;
    // Si Tesseract enderezó la imagen, giramos igual la original para que coincidan los recuadros.
    if (res.rotateRadians) {
      const rotated = rotateCanvas(source, res.rotateRadians);
      ocr.releaseCanvas(source);
      source = rotated;
      await setPreview(source);
    }
    els.ocrText.value = cleanOcrText(res.text);
    els.ocrProgress.hidden = true;
    els.edPanel.hidden = false;
    els.edSave.disabled = false;
    try { await els.ocrPreviewImg.decode(); } catch { /* se usará cuando cargue */ }
    picker.load({ imgUrl: previewUrl, width, height, words: res.words });
    if (!res.words.length) toast('No se reconoció texto. Acércate más, con buena luz y sin reflejos.', { ms: 4500 });
  } catch (err) {
    if (token !== ocrToken) return;
    console.error(err);
    closeEditor();
    const offline = navigator.onLine === false;
    toast(offline
      ? 'El OCR necesita descargarse una vez con conexión (Ajustes › Preparar OCR sin conexión).'
      : 'Error en el OCR: ' + (err && err.message || err), { ms: 6000 });
  } finally {
    ocr.releaseCanvas(det);
    ocr.releaseCanvas(source);
  }
}

async function setPreview(canvas) {
  const blob = await canvasToBlob(canvas);
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : null;
  if (previewUrl) els.ocrPreviewImg.src = previewUrl;
}

function cleanOcrText(t) {
  return String(t || '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Toma varios fotogramas seguidos y se queda con el más nítido (evita el movimiento al pulsar).
let capturing = false;
async function captureForOcr() {
  if (!camera.active || !els.video.videoWidth || capturing) return;
  capturing = true;
  flash();
  vibrate(30);
  try {
    const roi = camera.screenRectToVideo(els.frame.getBoundingClientRect());
    let best = null, bestScore = -1;
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 180 : 110));
      if (!camera.active) break;
      const c = camera.grab(roi, SOURCE_SIDE, document.createElement('canvas'));
      const score = sharpness(c, c.width, c.height);
      if (score > bestScore) { ocr.releaseCanvas(best); best = c; bestScore = score; }
      else ocr.releaseCanvas(c);
    }
    if (best) runOcr(best);
  } finally {
    capturing = false;
  }
}

async function saveEditorFields() {
  const fields = picker.result();
  if (!fields) {
    toast(state.settings.fields.length
      ? 'Toca en la foto al menos un dato para algún campo.'
      : 'Crea un campo con «+ Campo» y toca el dato en la foto.', { ms: 3500 });
    return;
  }
  if (await addRecords([{ id: newId(), type: 'ocr', format: 'OCR', value: '', fields, note: '', createdAt: Date.now() }], { announce: false })) {
    closeEditor();
    toast(`Fila guardada (${Object.keys(fields).length} ${Object.keys(fields).length === 1 ? 'campo' : 'campos'})`, { action: 'Ver lista', onAction: () => setTab('list') });
  }
}

async function handleFile(file) {
  if (!file) return;
  let loaded;
  try {
    loaded = await ocr.loadImage(file);
  } catch {
    toast('No se pudo abrir la imagen.');
    return;
  }
  const { img, release } = loaded;
  const w = img.naturalWidth, h = img.naturalHeight;
  try {
    if (state.mode === 'ocr') {
      const c = ocr.downscale(img, w, h, SOURCE_SIDE);
      release();
      runOcr(c);
      return;
    }
    toast('Buscando código en la foto…', { ms: 8000 });
    let result = null;
    for (const side of [1600, 1000]) {
      const c = ocr.downscale(img, w, h, side);
      result = await decodeStill(c);
      ocr.releaseCanvas(c);
      if (result) break;
    }
    release();
    hideToast();
    if (result) onDetected(result, { fromPhoto: true });
    else toast('No se encontró ningún código. Acércate más y evita reflejos.', { ms: 4500 });
  } catch (err) {
    release();
    console.error(err);
    toast('Error al analizar la foto.');
  }
}

// --- Modo -------------------------------------------------------------------------------------------------
function setMode(mode) {
  state.mode = mode;
  els.viewport.dataset.mode = mode;
  els.modeBarcode.setAttribute('aria-selected', String(mode === 'barcode'));
  els.modeOcr.setAttribute('aria-selected', String(mode === 'ocr'));
  safeLocal.set('mode', mode);
  if (mode === 'ocr') els.lastScan.hidden = true;
  if (camera.active && mode === 'barcode') startScanLoop();
  else stopScanLoop();
  if (camera.active) camera.setHighRes(mode === 'ocr');
  setCameraUi(camera.active);
}

// --- Exportación ---------------------------------------------------------------------------------------------
function exportClick(preferShare) {
  if (!state.records.length) { toast('No hay escaneos que exportar.'); return; }
  // En memoria y de forma síncrona para no perder el gesto del usuario (Safari).
  const csv = buildCsv(state.records, { sep: state.settings.sep, protectNumbers: state.settings.protect, fieldOrder: state.settings.fields });
  exportCsv(csv, csvFileName(), { preferShare }).then((r) => {
    if (r === 'downloaded') toast('CSV descargado.');
    else if (r === 'shared') toast('CSV compartido.');
  }).catch((err) => toast('No se pudo exportar: ' + (err && err.message || err)));
}

// --- Instalación y almacenamiento -----------------------------------------------------------------------------
let deferredPrompt = null;

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    els.installCard.hidden = false;
    els.settingsDot.hidden = false;
  });
  els.installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    try {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch { /* ignorar */ }
    deferredPrompt = null;
    els.installCard.hidden = true;
    els.settingsDot.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    els.installCard.hidden = true;
    els.settingsDot.hidden = true;
    deferredPrompt = null;
    toast('App instalada.');
    checkPersistence();
  });

  if (isIOS && !isStandalone() && safeLocal.get('iosInstallDismissed') !== '1') {
    [els.listNotices, els.settingsNotices].forEach((box) => {
      const n = $('tplIosNotice').content.firstElementChild.cloneNode(true);
      n.querySelector('.ios-not-safari').hidden = isIOSSafari;
      n.querySelector('.ios-close').addEventListener('click', () => {
        document.querySelectorAll('.ios-notice').forEach((x) => x.remove());
        safeLocal.set('iosInstallDismissed', '1');
      });
      box.appendChild(n);
    });
  }
}

async function checkPersistence() {
  const persisted = await requestPersistence();
  document.querySelectorAll('.storage-notice').forEach((n) => n.remove());
  if (persisted !== true) {
    const extra = persisted === null
      ? 'Este navegador no permite pedir almacenamiento persistente. Exporta el CSV con regularidad.'
      : isStandalone() ? 'Exporta el CSV con regularidad para no perder datos.' : null;
    [els.listNotices, els.settingsNotices].forEach((box) => {
      const inList = box === els.listNotices;
      // En la lista se puede cerrar (ocupa sitio); en Ajustes se muestra siempre.
      if (inList && safeLocal.get('storageNoticeDismissed') === '1') return;
      const n = $('tplStorageNotice').content.firstElementChild.cloneNode(true);
      n.classList.add('storage-notice');
      if (extra) n.querySelector('.storage-extra').textContent = extra;
      const close = n.querySelector('.storage-close');
      if (inList) close.addEventListener('click', () => { n.remove(); safeLocal.set('storageNoticeDismissed', '1'); });
      else close.remove();
      box.prepend(n);
    });
  }
  updateStorageInfo(persisted);
}

async function updateStorageInfo(persisted) {
  const est = await storageEstimate();
  const mb = (n) => (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  const p = persisted === true ? 'persistente' : persisted === false ? 'no persistente' : 'desconocido';
  els.storageInfo.textContent = `Almacenamiento ${p}` + (est && est.usage != null ? ` · ${mb(est.usage)} usados` : '');
}

// --- Ajustes ---------------------------------------------------------------------------------------------
function applySettingsToUi() {
  const s = state.settings;
  els.setSep.value = s.sep;
  els.setProtect.checked = !!s.protect;
  els.setLang.value = s.lang;
  els.setDedupe.checked = !!s.dedupe;
  els.setBeep.checked = !!s.beep;
  els.setDocType.value = s.docType || 'etiqueta';
  renderFieldList();
}
function saveSettings() {
  db.setSetting('prefs', state.settings).catch((err) => console.warn('ajustes', err));
}

// --- Service worker ----------------------------------------------------------------------------------------
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW', err));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    toast('Hay una versión nueva.', { action: 'Actualizar', onAction: () => { reloading = true; location.reload(); }, ms: 10000 });
  });
}

// --- Eventos ---------------------------------------------------------------------------------------------------
function bindEvents() {
  // Pestañas
  els.tabs.forEach((t) => t.addEventListener('click', () => { unlockAudio(); setTab(t.dataset.tab); }));
  els.emptyGoScan.addEventListener('click', () => setTab('scan'));

  // Cámara
  els.cameraBtn.addEventListener('click', () => { unlockAudio(); startCamera(); });
  els.modeBarcode.addEventListener('click', () => setMode('barcode'));
  els.modeOcr.addEventListener('click', () => setMode('ocr'));
  els.shutterBtn.addEventListener('click', () => {
    unlockAudio();
    if (state.mode === 'ocr') { captureForOcr(); return; }
    state.paused = !state.paused;
    setCameraUi(camera.active);
  });
  els.torchBtn.addEventListener('click', async () => {
    const ok = await camera.setTorch(!camera.torchOn);
    if (!ok) els.torchBtn.hidden = true; // sin errores visibles si no se admite
    els.torchBtn.setAttribute('aria-pressed', String(camera.torchOn));
  });
  els.switchCamBtn.addEventListener('click', async () => {
    els.switchCamBtn.disabled = true;
    stopScanLoop();
    try {
      await camera.switchCamera();
      setCameraUi(true);
      if (state.mode === 'barcode') startScanLoop();
    } catch (err) {
      setCameraUi(false);
      els.placeholderText.textContent = cameraErrorMessage(err);
    } finally {
      els.switchCamBtn.disabled = false;
    }
  });
  // Enfoque táctil (solo si la cámara lo admite).
  els.viewport.addEventListener('click', async (e) => {
    if (!camera.active || !camera.hasTapFocus) return;
    if (e.target.closest('button, label, .last-scan, .cam-top, .cam-bottom')) return;
    const box = els.viewport.getBoundingClientRect();
    els.focusRing.style.left = `${e.clientX - box.left}px`;
    els.focusRing.style.top = `${e.clientY - box.top}px`;
    els.focusRing.classList.remove('on');
    void els.focusRing.offsetWidth;
    els.focusRing.classList.add('on');
    const p = camera.screenPointToVideoNorm(e.clientX, e.clientY);
    await camera.focusAt(p.x, p.y);
  });
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = '';
    handleFile(f);
  });
  els.lastScanUndo.addEventListener('click', () => {
    if (!state.lastSaved) return;
    removeRecords([state.lastSaved.id]);
    state.lastSaved = null;
    state.lastHit = { text: '', at: 0 };
    els.lastScan.hidden = true;
  });
  els.lastScanValue.addEventListener('click', () => {
    const rec = state.lastSaved && state.records.find((r) => r.id === state.lastSaved.id);
    if (rec) { state.paused = true; setCameraUi(camera.active); openEdit(rec); }
  });

  // Editor
  els.ocrCancel.addEventListener('click', () => { ocr.terminate(); closeEditor(); });
  els.edCancel.addEventListener('click', async () => { if (await confirmDiscardIfNeeded()) closeEditor(); });
  els.edSave.addEventListener('click', saveEditorFields);
  els.fullTextBtn.addEventListener('click', () => {
    if (!hasDialog(els.textDialog)) return;
    openSheet(els.textDialog).then(async (action) => {
      if (action === 'all') {
        const value = els.ocrText.value.trim();
        if (!value) { toast('No hay texto que guardar.'); return; }
        if (await addRecords([{ id: newId(), type: 'ocr', format: 'OCR', value, note: '', createdAt: Date.now() }])) closeEditor();
      } else if (action === 'lines') {
        const lines = els.ocrText.value.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!lines.length) { toast('No hay texto que guardar.'); return; }
        const t = Date.now();
        if (await addRecords(lines.map((value, i) => ({ id: newId(), type: 'ocr', format: 'OCR', value, note: '', createdAt: t + i })))) closeEditor();
      }
    });
  });
  // Botón «atrás» de Android / gesto de volver: cierra el editor en lugar de salir.
  window.addEventListener('popstate', async () => {
    if (!editorOpen) return;
    editorPushed = false;
    if (picker.result()) {
      try { history.pushState({ editor: true }, ''); editorPushed = true; } catch { /* ignorar */ }
      if (await confirmAsk('¿Descartar los datos seleccionados?', 'Descartar')) closeEditor();
    } else {
      ocr.terminate();
      closeEditor({ fromPop: true });
    }
  });

  // Lista
  els.list.addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (!b) return;
    const rec = state.records.find((r) => r.id === b.dataset.id);
    if (rec) openEdit(rec);
  });
  els.searchInput.addEventListener('input', () => { state.query = els.searchInput.value; renderList(); });
  els.addManualBtn.addEventListener('click', () => openEdit(null));
  els.exportBtn.addEventListener('click', () => exportClick(true));
  els.downloadBtn.addEventListener('click', () => exportClick(false));
  els.clearBtn.addEventListener('click', async () => {
    if (!state.records.length) { toast('La lista ya está vacía.'); return; }
    const ok = await confirmAsk(`¿Borrar los ${state.records.length} escaneos? Exporta antes el CSV si los necesitas.`, 'Borrar todo');
    if (!ok) return;
    try {
      await db.clearRecords();
      state.records = [];
      renderList();
      toast('Lista borrada.');
    } catch { toast('No se pudo borrar.'); }
  });

  // Ajustes
  const onSetting = (key, read) => (e) => { state.settings[key] = read(e.target); saveSettings(); };
  els.setSep.addEventListener('change', onSetting('sep', (t) => t.value));
  els.setProtect.addEventListener('change', onSetting('protect', (t) => t.checked));
  els.setLang.addEventListener('change', onSetting('lang', (t) => t.value));
  els.setDedupe.addEventListener('change', onSetting('dedupe', (t) => t.checked));
  els.setDocType.addEventListener('change', onSetting('docType', (t) => t.value));
  els.fieldList.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-type-for]');
    if (!sel) return;
    setFieldType(sel.dataset.typeFor, sel.value);
    picker.refineAll();
  });
  els.fieldNameInput.addEventListener('input', syncTypeGuess);
  els.fieldTypeSelect.addEventListener('change', () => { els.fieldTypeSelect.dataset.touched = '1'; });
  els.setBeep.addEventListener('change', (e) => { state.settings.beep = e.target.checked; if (e.target.checked) { unlockAudio(); beep(); } saveSettings(); });
  els.settingsAddField.addEventListener('click', () => addFieldFlow());
  els.fieldList.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const f = b.dataset.remove;
    if (!(await confirmAsk(`¿Quitar el campo «${f}»? Los escaneos ya guardados no cambian.`, 'Quitar'))) return;
    setFields(state.settings.fields.filter((x) => x !== f));
    picker.fieldsChanged();
  });
  els.prefetchOcr.addEventListener('click', async () => {
    els.prefetchOcr.disabled = true;
    els.prefetchStatus.textContent = 'Descargando…';
    try {
      await ocr.prefetch(state.settings.lang, (p) => {
        els.prefetchStatus.textContent = `${p.status}… ${Math.round((p.progress || 0) * 100)}%`;
      });
      els.prefetchStatus.textContent = 'Listo: el OCR funciona sin conexión.';
    } catch (err) {
      els.prefetchStatus.textContent = 'No se pudo descargar: ' + (err && err.message || err);
    } finally {
      els.prefetchOcr.disabled = false;
    }
  });

  // Hojas: tocar fuera las cierra; validación del nombre de campo.
  document.querySelectorAll('dialog.sheet').forEach((d) => {
    // Ignora el «click» del mismo toque que abrió la hoja (llega justo después y caería en el fondo).
    d.addEventListener('click', (e) => { if (e.target === d && Date.now() - (d._openedAt || 0) > 400) d.close('cancel'); });
  });
  els.fieldForm.addEventListener('submit', (e) => {
    const submitter = e.submitter;
    if (submitter && submitter.value === 'cancel') return;
    const r = validateFieldName(els.fieldNameInput.value, state.settings.fields);
    if (r.error) {
      e.preventDefault();
      els.fieldNameInput.setCustomValidity(r.error);
      els.fieldNameInput.reportValidity();
    } else if (!submitter) {
      e.preventDefault();
      els.fieldDialog.close('ok'); // Enter en el teclado
    }
  });
  els.fieldNameInput.addEventListener('input', () => els.fieldNameInput.setCustomValidity(''));

  // iOS/Android cortan la cámara en segundo plano: la paramos y la reanudamos al volver.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopScanLoop();
      if (camera.active) camera.stop();
      setCameraUi(false);
    } else {
      resumeCameraIfWanted();
    }
  });
  window.addEventListener('pagehide', () => { if (camera.active) camera.stop(); });
}

// --- Inicio -------------------------------------------------------------------------------------------------
async function init() {
  els.appVersion.textContent = APP_VERSION;
  bindEvents();
  setupInstall();
  registerSW();

  if (!canUseCamera()) {
    els.cameraBtn.hidden = true;
    els.insecureNotice.hidden = window.isSecureContext;
    els.placeholderText.textContent = window.isSecureContext
      ? 'Este navegador no permite usar la cámara. Usa el botón de galería para analizar una foto.'
      : 'La cámara requiere HTTPS.';
  }
  // En iOS instalada, una descarga de blob puede dejar al usuario atrapado en un visor: solo compartir.
  if (isIOS && isStandalone() && typeof navigator.share === 'function') els.downloadBtn.hidden = true;

  try {
    const saved = await db.getSetting('prefs');
    if (saved && typeof saved === 'object') Object.assign(state.settings, saved);
    if (!Array.isArray(state.settings.fields)) state.settings.fields = [];
    if (!state.settings.fieldTypes || typeof state.settings.fieldTypes !== 'object') state.settings.fieldTypes = {};
  } catch (err) { console.warn(err); }
  applySettingsToUi();
  if (safeLocal.get('mode') === 'ocr') setMode('ocr');

  try {
    state.records = await db.allRecords();
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir la base de datos local. ¿Modo privado?', { ms: 6000 });
  }
  renderList();
  updateThemeColor();
  checkPersistence();
  // Si el usuario ya usó la cámara, se activa sola al abrir la app.
  resumeCameraIfWanted();
}

init();
