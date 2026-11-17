// Generación y exportación de CSV compatible con Excel (UTF-8 con BOM, CRLF).

export const FORMAT_LABELS = {
  QR_CODE: 'QR', EAN_13: 'EAN-13', EAN_8: 'EAN-8', UPC_A: 'UPC-A', UPC_E: 'UPC-E',
  CODE_128: 'Code 128', CODE_39: 'Code 39', CODE_93: 'Code 93', ITF: 'ITF', CODABAR: 'Codabar',
  DATA_MATRIX: 'Data Matrix', PDF_417: 'PDF417', AZTEC: 'Aztec', RSS_14: 'GS1 DataBar',
  RSS_EXPANDED: 'GS1 DataBar Exp.', OCR: 'OCR', MANUAL: 'Manual',
};

export function formatLabel(fmt) {
  return FORMAT_LABELS[fmt] || (fmt || '').replace(/_/g, ' ');
}

const pad = (n) => String(n).padStart(2, '0');
export function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const TYPE_LABELS = { barcode: 'Código', ocr: 'Texto', manual: 'Manual' };

// Prepara un valor para una celda de Excel.
function cell(value, { protectNumbers = false } = {}) {
  let v = value == null ? '' : String(value);
  v = v.replace(/\r\n?/g, '\n');
  if (protectNumbers && /^\d+$/.test(v) && (v.length >= 12 || (v.length > 1 && v[0] === '0'))) {
    // ="0123456789012" → Excel lo muestra como texto: sin perder ceros ni pasar a notación científica.
    v = `="${v}"`;
  } else if (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d+([.,]\d+)?$/.test(v)) {
    // Evita que un texto escaneado se interprete como fórmula (inyección CSV).
    v = `'${v}`;
  }
  return `"${v.replace(/"/g, '""')}"`;
}

export function buildCsv(records, { sep = ';', protectNumbers = true } = {}) {
  const header = ['Fecha', 'Tipo', 'Formato', 'Valor', 'Nota'];
  const lines = [header.map((h) => cell(h)).join(sep)];
  // Orden cronológico (el más antiguo primero) en el archivo.
  const rows = [...records].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of rows) {
    lines.push([
      cell(formatDate(r.createdAt)),
      cell(TYPE_LABELS[r.type] || r.type),
      cell(formatLabel(r.format)),
      cell(r.value, { protectNumbers }),
      cell(r.note || ''),
    ].join(sep));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function csvFileName(date = new Date()) {
  const d = date;
  return `escaneos-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
}

// Comparte el CSV con navigator.share (archivo) si se puede; si no, descarga.
// Debe llamarse de forma síncrona dentro del gesto del usuario (Safari lo exige).
// Devuelve 'shared' | 'cancelled' | 'downloaded'.
export async function exportCsv(csvText, fileName, { preferShare = true } = {}) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  if (preferShare && typeof navigator.share === 'function' && typeof File === 'function') {
    let file = null;
    try { file = new File([blob], fileName, { type: 'text/csv' }); } catch { file = null; }
    let can = false;
    try { can = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }); } catch { can = false; }
    if (can) {
      try {
        await navigator.share({ files: [file], title: fileName });
        return 'shared';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        // NotAllowedError, etc. → descarga normal.
        console.warn('navigator.share falló, se descarga el archivo', err);
      }
    }
  }
  downloadBlob(blob, fileName);
  return 'downloaded';
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 30000);
}
