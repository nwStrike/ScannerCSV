// Tipos de campo: limitan los caracteres que el OCR puede devolver y corrigen confusiones típicas.

export const FIELD_TYPES = {
  texto: { label: 'Texto', short: 'Texto' },
  numero: { label: 'Número / importe (solo cifras)', short: 'Número', whitelist: '0123456789.,-+€$%' },
  fecha: { label: 'Fecha', short: 'Fecha', whitelist: '0123456789/-.:' },
  codigo: { label: 'Código / lote (mayúsculas y cifras)', short: 'Código', whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/.' },
};

const NAME_HINTS = [
  [/total|importe|base|iva|precio|cantidad|uds|unidades|peso|neto|bruto|kg|cajas|bultos/i, 'numero'],
  [/fecha|caducidad|consumo|exp|cad\b|envasado|fabricaci/i, 'fecha'],
  [/lote|lot\b|ref|referencia|c[oó]digo|n[ºo°]|n[uú]mero|sku|ean|nif|cif|albar|factura|serie|pedido/i, 'codigo'],
];

// Tipo sugerido según el nombre del campo.
export function guessType(name) {
  const n = String(name || '');
  for (const [re, type] of NAME_HINTS) if (re.test(n)) return type;
  return 'texto';
}

// Letras que el OCR suele confundir con cifras.
const TO_DIGIT = { O: '0', o: '0', D: '0', Q: '0', U: '0', I: '1', l: '1', i: '1', '|': '1', '!': '1', L: '1', Z: '2', z: '2', S: '5', s: '5', G: '6', b: '6', T: '7', B: '8', g: '9', q: '9' };

// Corrige letras→cifras solo en los trozos que ya son mayoritariamente numéricos
// (así «kg» o «EUR» no se convierten en cifras); descarta trozos sin ninguna cifra.
function lettersToDigits(s) {
  return s.split(' ').map((tok) => {
    if (/^[€$%]+$/.test(tok)) return tok;
    const digits = (tok.match(/\d/g) || []).length;
    const letters = (tok.match(/[A-Za-z|!]/g) || []).length;
    if (!digits) return '';
    if (letters > digits) return tok.replace(/[A-Za-z|!]/g, '');
    return tok.replace(/[A-Za-z|!]/g, (ch) => TO_DIGIT[ch] ?? '');
  }).filter(Boolean).join(' ');
}

// Limpia el valor leído según el tipo de campo.
export function cleanValue(type, raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return s;
  switch (type) {
    case 'numero':
      s = lettersToDigits(s)
        .replace(/(\d)\s+(?=[\d.,])/g, '$1') // "1 234,56" → "1234,56" (espacios dentro de la cifra)
        .replace(/([.,])\s+(?=\d)/g, '$1')
        .replace(/[^0-9.,\-+€$% ]/g, '')
        .trim();
      break;
    case 'fecha':
      s = lettersToDigits(s)
        .replace(/\s*([/\-.])\s*/g, '$1')
        .replace(/[^0-9/\-.: ]/g, '')
        .trim();
      break;
    case 'codigo':
      s = s.toUpperCase().replace(/[^A-Z0-9\-/. ]/g, '').replace(/\s+/g, ' ').trim();
      break;
    default:
      break;
  }
  return s;
}

// Parámetros de Tesseract para releer un recorte de este tipo.
export function tessParams(type, singleLine) {
  const p = {
    tessedit_pageseg_mode: singleLine ? '7' : '6',
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  };
  const wl = FIELD_TYPES[type] && FIELD_TYPES[type].whitelist;
  if (wl) p.tessedit_char_whitelist = wl;
  return p;
}
