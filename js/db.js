// Almacenamiento en IndexedDB (escaneos + ajustes).
const DB_NAME = 'scannercsv';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) { reject(new Error('IndexedDB no disponible')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) {
        const s = db.createObjectStore('records', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    req.onsuccess = () => {
      const db = req.result;
      // Si otra pestaña actualiza la BD, cerramos para no bloquearla.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('IndexedDB bloqueada por otra pestaña');
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacción abortada'));
  }));
}

export const db = {
  allRecords: () => tx('records', 'readonly', (s) => s.getAll())
    .then((rows) => (rows || []).sort((a, b) => b.createdAt - a.createdAt)),
  putRecord: (rec) => tx('records', 'readwrite', (s) => s.put(rec)),
  putRecords: (recs) => tx('records', 'readwrite', (s) => { recs.forEach((r) => s.put(r)); }),
  deleteRecord: (id) => tx('records', 'readwrite', (s) => s.delete(id)),
  clearRecords: () => tx('records', 'readwrite', (s) => s.clear()),
  getSetting: (key) => tx('settings', 'readonly', (s) => s.get(key)),
  setSetting: (key, value) => tx('settings', 'readwrite', (s) => s.put(value, key)),
};

export function newId() {
  if (self.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Pide almacenamiento persistente. Devuelve true | false | null (API no disponible).
export async function requestPersistence() {
  const st = navigator.storage;
  if (!st || typeof st.persisted !== 'function') return null;
  try {
    if (await st.persisted()) return true;
    if (typeof st.persist === 'function') return await st.persist();
    return false;
  } catch {
    return false;
  }
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch { /* sin datos */ }
  return null;
}
