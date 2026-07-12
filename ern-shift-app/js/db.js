// IndexedDB 薄ラッパ（オフラインファースト・端末内完結）
const DB_NAME = 'ern-shift-db';
const DB_VERSION = 1;

// store 定義: [name, keyPath, indexes[]]
const STORES = [
  ['shifts', 'id', []],
  ['rounds', 'id', ['shift_id']],
  ['patients', 'id', ['shift_id']],
  ['patient_rounds', 'id', ['shift_id', 'patient_id', 'round_id']],
  ['infections', 'patient_id', []],
  ['interventions', 'id', ['shift_id', 'patient_id', 'round_id']],
  ['raceflips', 'id', ['shift_id', 'patient_id']],
  ['settings', 'key', []],
];

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      for (const [name, keyPath, indexes] of STORES) {
        if (!idb.objectStoreNames.contains(name)) {
          const os = idb.createObjectStore(name, { keyPath });
          for (const idx of indexes) os.createIndex(idx, idx);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async put(store, value) {
    const idb = await openDB();
    return reqAsPromise(idb.transaction(store, 'readwrite').objectStore(store).put(value));
  },
  async bulkPut(store, values) {
    const idb = await openDB();
    const tx = idb.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async get(store, key) {
    const idb = await openDB();
    return reqAsPromise(idb.transaction(store).objectStore(store).get(key));
  },
  async del(store, key) {
    const idb = await openDB();
    return reqAsPromise(idb.transaction(store, 'readwrite').objectStore(store).delete(key));
  },
  async all(store) {
    const idb = await openDB();
    return reqAsPromise(idb.transaction(store).objectStore(store).getAll());
  },
  async byIndex(store, index, value) {
    const idb = await openDB();
    return reqAsPromise(
      idb.transaction(store).objectStore(store).index(index).getAll(IDBKeyRange.only(value))
    );
  },
  async clearAll() {
    const idb = await openDB();
    const names = STORES.map(s => s[0]);
    const tx = idb.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

export function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
}
