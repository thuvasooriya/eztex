const DB_NAME = "eztex-v3";
const DB_VERSION = 1;

const STORE_NAMES = [
  "projects",
  "rooms",
  "folder_handles",
  "pending_deletes",
  "ui_prefs",
];

let _db: IDBDatabase | null = null;
let _db_promise: Promise<IDBDatabase> | null = null;

export async function open_db(): Promise<IDBDatabase> {
  if (_db) return _db;
  if (_db_promise) return _db_promise;

  _db_promise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name);
        }
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onclose = () => { _db = null; _db_promise = null; };
      resolve(_db);
    };
    req.onerror = () => {
      _db_promise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      _db_promise = null;
      reject(new Error("IndexedDB open blocked"));
    };
  });

  return _db_promise;
}

export async function delete_database(): Promise<void> {
  if (_db) {
    _db.close();
    _db = null;
  }
  _db_promise = null;

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`Failed to delete ${DB_NAME}`));
    req.onblocked = () => reject(new Error(`Delete blocked for ${DB_NAME}`));
  });
}

function tx_complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

export async function get_store(store_name: string, mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
  const db = await open_db();
  const tx = db.transaction(store_name, mode);
  return tx.objectStore(store_name);
}

export async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function put<T>(store: string, value: T, key?: string): Promise<void> {
  const db = await open_db();
  const tx = db.transaction(store, "readwrite");
  if (key !== undefined) {
    tx.objectStore(store).put(value, key);
  } else {
    tx.objectStore(store).put(value);
  }
  await tx_complete(tx);
}

export async function remove(store: string, key: string): Promise<void> {
  const db = await open_db();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await tx_complete(tx);
}

export async function get_all<T>(store: string): Promise<T[]> {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function clear_store(store: string): Promise<void> {
  const db = await open_db();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).clear();
  await tx_complete(tx);
}
