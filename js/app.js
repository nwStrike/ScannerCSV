// ScannerCSV — lógica principal.
import { db, newId, requestPersistence, storageEstimate } from './db.js';
import { buildCsv, csvFileName, exportCsv, formatLabel, formatDate } from './csv.js';
import { Camera } from './camera.js';
import * as ocr from './ocr.js';
import { FieldPicker } from './fields.js';

const APP_VERSION = '1.1.0';
const MAX_RENDERED = 500;
const SCAN_SIDE = 800; // lado largo de la región que se envía al lector de códigos
const COOLDOWN_MS = 2500;

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'), viewport: $('viewport'), frame: $('frame'), flash: $('flash'), focusRing: $('focusRing'),
  placeholderText: $('placeholderText'), camHint: $('camHint'),
  cameraBtn: $('cameraBtn'), captureBtn: $('captureBtn'), torchBtn: $('torchBtn'), switchCamBtn: $('switchCamBtn'),
  fileInput: $('fileInput'), modeBarcode: $('modeBarcode'), modeOcr: $('modeOcr'),
  ocrPanel: $('ocrPanel'), ocrProgress: $('ocrProgress'), ocrStatus: $('ocrStatus'), ocrPct: $('ocrPct'),
  ocrBar: $('ocrBar'), ocrFill: $('ocrFill'), ocrCancel: $('ocrCancel'), ocrResult: $('ocrResult'),
  ocrPreview: $('ocrPreview'), ocrText: $('ocrText'), ocrSave: $('ocrSave'), ocrSaveLines: $('ocrSaveLines'),
  ocrDiscard: $('ocrDiscard'), ocrSaveFields: $('ocrSaveFields'), editValueField: $('editValueField'), editFields: $('editFields'),
  list: $('list'), count: $('count'), emptyList: $('emptyList'), addManualBtn: $('addManualBtn'),
  exportBtn: $('exportBtn'), downloadBtn: $('downloadBtn'), clearBtn: $('clearBtn'),
  editDialog: $('editDialog'), editForm: $('editForm'), editTitle: $('editTitle'), editValue: $('editValue'),
  editNote: $('editNote'), editMeta: $('editMeta'), editDelete: $('editDelete'),
  confirmDialog: $('confirmDialog'), confirmText: $('confirmText'),
  toast: $('toast'), toastText: $('toastText'), toastAction: $('toastAction'),
  installBtn: $('installBtn'), iosInstallNotice: $('iosInstallNotice'), iosInstallClose: $('iosInstallClose'),
  iosNotSafari: $('iosNotSafari'), storageNotice: $('storageNotice'), storageNoticeExtra: $('storageNoticeExtra'),
  insecureNotice: $('insecureNotice'), storageInfo: $('storageInfo'), appVersion: $('appVersion'),
  setSep: $('setSep'), setProtect: $('setProtect'), setLang: $('setLang'), setDedupe: $('setDedupe'), setBeep: $('setBeep'),
  prefetchOcr: $('prefetchOcr'), prefetchStatus: $('prefetchStatus'),
};

// --- Plataforma -------------------------------------------------------------
const ua = navigator.userAgent || '';
const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Instagram|FBAN|FBAV/.test(ua);
const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;

const safeLocal = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
};

// --- Estado -----------------------------------------------------------------
const state = {
  mode: 'barcode',
  records: [],
  settings: { sep: ';', protect: true, lang: 'spa', dedupe: false, beep: true, fields: [] },
  wasRunningBeforeHide: false,
  lastHit: { text: '', at: 0 },
  newIds: new Set(),
};

const camera = new Camera(els.video);
const picker = new FieldPicker({
  chips: $('fieldChips'), editBtn: $('fieldsEditBtn'), help: $('fieldsHelp'), noFieldsHint: $('noFieldsHint'),
  addForm: $('addFieldForm'), addInput: $('addFieldInput'), addCancel: $('addFieldCancel'),
  stage: $('ocrStage'), wrap: $('ocrCanvasWrap'), img: $('ocrPreview'), svg: $('ocrOverlay'),
  zoomBtn: $('ocrZoomBtn'), stageHint: $('stageHint'), values: $('fieldValues'),
}, {
  getFields: () => state.settings.fields,
  setFields: (f) => { state.settings.fields = f; saveSettings(); },
  toast: (m) => toast(m, { ms: 3500 }),
});
let scanTimer = null;
let scanPending = false;
let scanPendingSince = 0;
let scanReqId = 0;
const scanCanvas = document.createElement('canvas');
let barcodeWorker = null;
let stillRequests = new Map();

// --- Utilidades UI ------------------------------------------------------------
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

function hasDialog(d) { return d && typeof d.showModal === 'function'; }

function confirmAsk(text) {
  if (!hasDialog(els.confirmDialog)) return Promise.resolve(window.confirm(text));
  return new Promise((resolve) => {
    els.confirmText.textContent = text;
    els.confirmDialog.returnValue = '';
    els.confirmDialog.addEventListener('close', () => resolve(els.confirmDialog.returnValue === 'ok'), { once: true });
    els.confirmDialog.showModal();
  });
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

// --- Registros ----------------------------------------------------------------
async function addRecords(recs, { announce = true } = {}) {
  if (!recs.length) return;
  try {
    await db.putRecords(recs);
  } catch (err) {
    console.error(err);
    toast('No se pudo guardar: ' + (err && err.message || err), { ms: 5000 });
    return;
  }
  state.records = [...recs].reverse().concat(state.records);
  recs.forEach((r) => state.newIds.add(r.id));
  renderList();
  if (announce) {
    const label = recs.length === 1 ? `Guardado: ${truncate(recs[0].value, 40)}` : `${recs.length} filas guardadas`;
    toast(label, { action: 'Deshacer', onAction: () => removeRecords(recs.map((r) => r.id)), ms: 3500 });
  }
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

function truncate(s, n) { s = String(s || '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function renderList() {
  const recs = state.records;
  els.count.textContent = String(recs.length);
  els.emptyList.hidden = recs.length > 0;
  const frag = document.createDocumentFragment();
  recs.slice(0, MAX_RENDERED).forEach((r) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item' + (state.newIds.has(r.id) ? ' new' : '');
    b.dataset.id = r.id;
    const tag = document.createElement('span');
    tag.className = 'item-tag' + (r.type === 'ocr' ? ' ocr' : '');
    tag.textContent = r.type === 'ocr' ? 'TXT' : formatLabel(r.format);
    const main = document.createElement('span');
    main.className = 'item-main';
    const val = document.createElement('span');
    val.className = 'item-value';
    if (r.fields && Object.keys(r.fields).length) {
      tag.textContent = 'DOC';
      Object.entries(r.fields).forEach(([k, v], i) => {
        if (i) val.append(' · ');
        const b = document.createElement('b');
        b.textContent = k + ': ';
        val.append(b, v);
      });
      val.classList.add('item-fields');
    } else {
      val.textContent = r.value;
    }
    const meta = document.createElement('span');
    meta.className = 'item-meta';
    meta.textContent = formatDate(r.createdAt) + (r.note ? ' · ' + r.note : '');
    main.append(val, document.createElement('br'), meta);
    b.append(tag, main);
    li.appendChild(b);
    frag.appendChild(li);
  });
  if (recs.length > MAX_RENDERED) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = `Se muestran los ${MAX_RENDERED} más recientes de ${recs.length}. El CSV incluye todos.`;
    frag.appendChild(li);
  }
  els.list.replaceChildren(frag);
  state.newIds.clear();
}

// --- Edición --------------------------------------------------------------------
function openEdit(rec) {
  const isNew = !rec;
  if (!hasDialog(els.editDialog)) {
    // Respaldo sin <dialog> (navegadores muy antiguos).
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
  els.editDialog.returnValue = '';
  els.editDialog.addEventListener('close', async () => {
    const action = els.editDialog.returnValue;
    if (action === 'save') {
      const note = els.editNote.value.trim();
      let updated;
      if (hasFields) {
        const fields = {};
        Object.entries(fieldInputs).forEach(([k, input]) => { const v = input.value.trim(); if (v) fields[k] = v; });
        if (!Object.keys(fields).length) { toast('Todos los campos están vacíos: no se ha guardado. Usa «Eliminar» para borrarlo.', { ms: 4500 }); return; }
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
      } catch (err) { toast('No se pudo guardar'); }
    } else if (action === 'delete' && rec) {
      await removeRecords([rec.id]);
      toast('Eliminado', { action: 'Deshacer', onAction: () => addRecords([rec], { announce: false }) });
    }
  }, { once: true });
  els.editDialog.showModal();
}

// --- Cámara ---------------------------------------------------------------------
function setCameraUi(running) {
  els.viewport.classList.toggle('live', running);
  els.cameraBtn.textContent = running ? 'Detener cámara' : 'Iniciar cámara';
  els.cameraBtn.classList.toggle('btn-primary', !running);
  els.cameraBtn.classList.toggle('btn-secondary', running);
  els.captureBtn.hidden = !(running && state.mode === 'ocr');
  // Linterna / cambio de cámara: solo si el dispositivo lo admite (en iOS normalmente no se muestran).
  els.torchBtn.hidden = !(running && camera.hasTorch);
  els.torchBtn.setAttribute('aria-pressed', String(running && camera.torchOn));
  els.switchCamBtn.hidden = !(running && camera.canSwitch);
  updateHint();
}

function updateHint() {
  if (!camera.active) { els.camHint.textContent = ''; return; }
  const focus = camera.hasTapFocus ? ' Toca la imagen para enfocar.' : '';
  els.camHint.textContent = state.mode === 'barcode'
    ? 'Centra el código dentro del marco.' + focus
    : 'Encuadra el texto y pulsa «Capturar texto».' + focus;
}

function cameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return isIOS
      ? 'Permiso de cámara denegado. Actívalo en Ajustes › Safari › Cámara (o en «aA» › Ajustes del sitio web) y vuelve a intentarlo.'
      : 'Permiso de cámara denegado. Actívalo desde el icono del candado junto a la dirección y vuelve a intentarlo.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No se encontró ninguna cámara.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'La cámara está ocupada por otra aplicación. Ciérrala y vuelve a intentarlo.';
  return 'No se pudo iniciar la cámara' + (err && err.message ? `: ${err.message}` : '.');
}

async function startCamera(deviceId) {
  if (!window.isSecureContext || !Camera.isSupported()) {
    els.placeholderText.textContent = 'La cámara no está disponible en este navegador. Usa «Desde foto».';
    return;
  }
  els.cameraBtn.disabled = true;
  els.placeholderText.textContent = 'Iniciando cámara…';
  try {
    await camera.start(deviceId);
    setCameraUi(true);
    if (state.mode === 'barcode') startScanLoop();
  } catch (err) {
    console.warn(err);
    camera.stop();
    setCameraUi(false);
    els.placeholderText.textContent = cameraErrorMessage(err);
  } finally {
    els.cameraBtn.disabled = false;
  }
}

function stopCamera() {
  stopScanLoop();
  camera.stop();
  setCameraUi(false);
  els.placeholderText.textContent = 'Pulsa «Iniciar cámara» para escanear.';
}

// --- Lectura de códigos ------------------------------------------------------------
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
    if (result) onDetected(result);
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
    if (scanPending && Date.now() - scanPendingSince > 3000) scanPending = false; // por si se pierde una respuesta
    if (!scanPending && v.readyState >= 2 && v.videoWidth > 0 && document.visibilityState === 'visible') {
      try {
        const roi = camera.screenRectToVideo(els.frame.getBoundingClientRect());
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

function onDetected(result, { fromPhoto = false } = {}) {
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
    toast(`Ya estaba en la lista: ${truncate(text, 40)}`);
    return;
  }
  addRecords([{ id: newId(), type: 'barcode', format: result.format || '', value: text, note: '', createdAt: now }]);
}

// --- OCR ---------------------------------------------------------------------------
let ocrToken = 0;
let previewUrl = null;

function setOcrProgress(p) {
  const pct = Math.round((p.progress || 0) * 100);
  els.ocrStatus.textContent = (p.status || 'Procesando') + '…';
  els.ocrPct.textContent = `${pct}%`;
  els.ocrFill.style.width = `${pct}%`;
  els.ocrBar.setAttribute('aria-valuenow', String(pct));
}

function canvasToBlob(c) {
  return new Promise((resolve) => {
    if (c.toBlob) c.toBlob((b) => resolve(b), 'image/jpeg', 0.85);
    else resolve(null);
  });
}

async function runOcr(canvas) {
  const token = ++ocrToken;
  els.ocrPanel.hidden = false;
  els.ocrResult.hidden = true;
  els.ocrProgress.hidden = false;
  setOcrProgress({ status: 'Preparando', progress: 0 });
  els.ocrPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const blob = await canvasToBlob(canvas);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = blob ? URL.createObjectURL(blob) : null;
    const width = canvas.width, height = canvas.height;
    const { text, words } = await ocr.recognize(canvas, state.settings.lang, (p) => { if (token === ocrToken) setOcrProgress(p); });
    if (token !== ocrToken) return;
    els.ocrText.value = cleanOcrText(text);
    els.ocrProgress.hidden = true;
    els.ocrResult.hidden = false;
    picker.load({ imgUrl: previewUrl, width, height, words });
    els.ocrResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!words.length) toast('No se reconoció texto. Prueba con más luz o más cerca.', { ms: 4000 });
  } catch (err) {
    if (token !== ocrToken) return;
    console.error(err);
    els.ocrPanel.hidden = true;
    const offline = navigator.onLine === false;
    toast(offline
      ? 'El OCR necesita descargarse una vez con conexión. Usa «Preparar OCR sin conexión» cuando tengas Internet.'
      : 'Error en el OCR: ' + (err && err.message || err), { ms: 6000 });
  } finally {
    ocr.releaseCanvas(canvas);
  }
}

function cleanOcrText(t) {
  return String(t || '')
    .replace(/\r\n?/g, '\n')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function closeOcrPanel() {
  els.ocrPanel.hidden = true;
  els.ocrText.value = '';
  picker.reset();
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
}

function captureForOcr() {
  if (!camera.active || !els.video.videoWidth) return;
  const roi = camera.screenRectToVideo(els.frame.getBoundingClientRect());
  // Reducimos a ≤1600 px de lado largo antes del OCR (memoria en iPhones antiguos).
  const c = camera.grab(roi, ocr.MAX_OCR_SIDE, document.createElement('canvas'));
  flash();
  runOcr(c);
}

async function handleFile(file) {
  if (!file) return;
  let loaded;
  try {
    loaded = await ocr.loadImage(file);
  } catch (err) {
    toast('No se pudo abrir la imagen.');
    return;
  }
  const { img, release } = loaded;
  const w = img.naturalWidth, h = img.naturalHeight;
  try {
    if (state.mode === 'ocr') {
      const c = ocr.downscale(img, w, h, ocr.MAX_OCR_SIDE);
      release();
      runOcr(c);
      return;
    }
    // Código de barras desde foto: probamos a dos escalas.
    els.camHint.textContent = 'Buscando código en la foto…';
    let result = null;
    for (const side of [1600, 1000]) {
      const c = ocr.downscale(img, w, h, side);
      result = await decodeStill(c);
      ocr.releaseCanvas(c);
      if (result) break;
    }
    release();
    updateHint();
    if (result) onDetected(result, { fromPhoto: true });
    else toast('No se encontró ningún código en la foto. Prueba a acercarte y evita reflejos.', { ms: 4500 });
  } catch (err) {
    release();
    console.error(err);
    toast('Error al analizar la foto.');
  }
}

// --- Modo ----------------------------------------------------------------------------
function setMode(mode) {
  state.mode = mode;
  els.viewport.dataset.mode = mode;
  els.modeBarcode.setAttribute('aria-selected', String(mode === 'barcode'));
  els.modeOcr.setAttribute('aria-selected', String(mode === 'ocr'));
  els.captureBtn.hidden = !(camera.active && mode === 'ocr');
  if (camera.active && mode === 'barcode') startScanLoop();
  else stopScanLoop();
  updateHint();
}

// --- Exportación -------------------------------------------------------------------------
function exportClick(preferShare) {
  if (!state.records.length) { toast('No hay escaneos que exportar.'); return; }
  // Se genera en memoria y de forma síncrona para no perder el gesto del usuario (Safari).
  const csv = buildCsv(state.records, { sep: state.settings.sep, protectNumbers: state.settings.protect, fieldOrder: state.settings.fields });
  exportCsv(csv, csvFileName(), { preferShare }).then((r) => {
    if (r === 'downloaded') toast('CSV descargado.');
    else if (r === 'shared') toast('CSV compartido.');
  }).catch((err) => toast('No se pudo exportar: ' + (err && err.message || err)));
}

// --- Instalación y almacenamiento ----------------------------------------------------------
let deferredPrompt = null;

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    els.installBtn.hidden = false;
  });
  els.installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    els.installBtn.hidden = true;
    try {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch { /* ignorar */ }
    deferredPrompt = null;
  });
  window.addEventListener('appinstalled', () => {
    els.installBtn.hidden = true;
    deferredPrompt = null;
    toast('App instalada.');
    checkPersistence();
  });

  if (isIOS && !isStandalone() && safeLocal.get('iosInstallDismissed') !== '1') {
    els.iosInstallNotice.hidden = false;
    els.iosNotSafari.hidden = isIOSSafari;
  }
  els.iosInstallClose.addEventListener('click', () => {
    els.iosInstallNotice.hidden = true;
    safeLocal.set('iosInstallDismissed', '1');
  });
}

async function checkPersistence() {
  const persisted = await requestPersistence();
  els.storageNotice.hidden = persisted === true;
  if (persisted === null) els.storageNoticeExtra.textContent = 'Este navegador no permite pedir almacenamiento persistente. Exporta el CSV con regularidad.';
  else if (isStandalone()) els.storageNoticeExtra.textContent = 'Exporta el CSV con regularidad para no perder datos.';
  updateStorageInfo(persisted);
}

async function updateStorageInfo(persisted) {
  const est = await storageEstimate();
  const mb = (n) => (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  const p = persisted === true ? 'persistente' : persisted === false ? 'no persistente' : 'desconocido';
  els.storageInfo.textContent = `Almacenamiento: ${p}` + (est && est.usage != null ? ` · usado ${mb(est.usage)}` + (est.quota ? ` de ${mb(est.quota)}` : '') : '');
}

// --- Ajustes ------------------------------------------------------------------------------------
function applySettingsToUi() {
  const s = state.settings;
  els.setSep.value = s.sep;
  els.setProtect.checked = !!s.protect;
  els.setLang.value = s.lang;
  els.setDedupe.checked = !!s.dedupe;
  els.setBeep.checked = !!s.beep;
}
function saveSettings() {
  db.setSetting('prefs', state.settings).catch((err) => console.warn('ajustes', err));
}

// --- Service worker ---------------------------------------------------------------------------
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

// --- Eventos ------------------------------------------------------------------------------------
function bindEvents() {
  els.cameraBtn.addEventListener('click', () => {
    unlockAudio();
    if (camera.active) stopCamera();
    else startCamera();
  });
  els.captureBtn.addEventListener('click', captureForOcr);
  els.modeBarcode.addEventListener('click', () => setMode('barcode'));
  els.modeOcr.addEventListener('click', () => setMode('ocr'));

  els.torchBtn.addEventListener('click', async () => {
    const ok = await camera.setTorch(!camera.torchOn);
    if (!ok) els.torchBtn.hidden = true; // sin errores visibles si el dispositivo no lo admite
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
    if (e.target.closest('button')) return;
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

  els.ocrCancel.addEventListener('click', () => {
    ocrToken++;
    ocr.terminate();
    closeOcrPanel();
  });
  els.ocrDiscard.addEventListener('click', closeOcrPanel);
  els.ocrSaveFields.addEventListener('click', async () => {
    const fields = picker.result();
    if (!fields) {
      toast(state.settings.fields.length ? 'Asigna al menos un dato a un campo.' : 'Crea un campo y toca los datos en la foto.');
      return;
    }
    await addRecords([{ id: newId(), type: 'ocr', format: 'OCR', value: '', fields, note: '', createdAt: Date.now() }]);
    closeOcrPanel();
  });
  els.ocrSave.addEventListener('click', async () => {
    const value = els.ocrText.value.trim();
    if (!value) { toast('No hay texto que guardar.'); return; }
    await addRecords([{ id: newId(), type: 'ocr', format: 'OCR', value, note: '', createdAt: Date.now() }]);
    closeOcrPanel();
  });
  els.ocrSaveLines.addEventListener('click', async () => {
    const lines = els.ocrText.value.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) { toast('No hay texto que guardar.'); return; }
    const t = Date.now();
    await addRecords(lines.map((value, i) => ({ id: newId(), type: 'ocr', format: 'OCR', value, note: '', createdAt: t + i })));
    closeOcrPanel();
  });

  els.list.addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (!b) return;
    const rec = state.records.find((r) => r.id === b.dataset.id);
    if (rec) openEdit(rec);
  });
  els.addManualBtn.addEventListener('click', () => openEdit(null));

  els.exportBtn.addEventListener('click', () => exportClick(true));
  els.downloadBtn.addEventListener('click', () => exportClick(false));
  els.clearBtn.addEventListener('click', async () => {
    if (!state.records.length) { toast('La lista ya está vacía.'); return; }
    const ok = await confirmAsk(`¿Borrar los ${state.records.length} escaneos? Exporta antes el CSV si los necesitas.`);
    if (!ok) return;
    try {
      await db.clearRecords();
      state.records = [];
      renderList();
      toast('Lista borrada.');
    } catch (err) { toast('No se pudo borrar.'); }
  });

  const onSetting = (key, read) => (e) => { state.settings[key] = read(e.target); saveSettings(); };
  els.setSep.addEventListener('change', onSetting('sep', (t) => t.value));
  els.setProtect.addEventListener('change', onSetting('protect', (t) => t.checked));
  els.setLang.addEventListener('change', onSetting('lang', (t) => t.value));
  els.setDedupe.addEventListener('change', onSetting('dedupe', (t) => t.checked));
  els.setBeep.addEventListener('change', (e) => { state.settings.beep = e.target.checked; if (e.target.checked) unlockAudio(); saveSettings(); });

  els.prefetchOcr.addEventListener('click', async () => {
    els.prefetchOcr.disabled = true;
    els.prefetchStatus.textContent = 'Descargando…';
    try {
      await ocr.prefetch(state.settings.lang, (p) => {
        els.prefetchStatus.textContent = `${p.status}… ${Math.round((p.progress || 0) * 100)}%`;
      });
      els.prefetchStatus.textContent = 'OCR listo para usar sin conexión.';
      safeLocal.set('ocrReady:' + state.settings.lang, '1');
    } catch (err) {
      els.prefetchStatus.textContent = 'No se pudo descargar: ' + (err && err.message || err);
    } finally {
      els.prefetchOcr.disabled = false;
    }
  });

  // iOS/Android cortan la cámara en segundo plano: la paramos y la reanudamos al volver.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      state.wasRunningBeforeHide = camera.active;
      if (camera.active) { stopScanLoop(); camera.stop(); setCameraUi(false); }
    } else if (state.wasRunningBeforeHide) {
      state.wasRunningBeforeHide = false;
      startCamera();
    }
  });
  window.addEventListener('pagehide', () => { if (camera.active) camera.stop(); });
}

// --- Inicio ---------------------------------------------------------------------------------------
async function init() {
  els.appVersion.textContent = APP_VERSION;
  bindEvents();
  setupInstall();
  registerSW();

  if (!window.isSecureContext || !Camera.isSupported()) {
    els.insecureNotice.hidden = window.isSecureContext;
    els.cameraBtn.disabled = true;
    els.placeholderText.textContent = window.isSecureContext
      ? 'Este navegador no permite usar la cámara. Usa «Desde foto».'
      : 'La cámara requiere HTTPS. Usa «Desde foto».';
  }
  // En iOS instalada, una descarga de blob puede dejar al usuario atrapado en un visor: solo compartir.
  if (isIOS && isStandalone() && typeof navigator.share === 'function') els.downloadBtn.hidden = true;

  try {
    const saved = await db.getSetting('prefs');
    if (saved && typeof saved === 'object') Object.assign(state.settings, saved);
    if (!Array.isArray(state.settings.fields)) state.settings.fields = [];
  } catch (err) { console.warn(err); }
  applySettingsToUi();

  try {
    state.records = await db.allRecords();
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir la base de datos local. ¿Modo privado?', { ms: 6000 });
  }
  renderList();
  checkPersistence();
}

init();
