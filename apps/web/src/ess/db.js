/* global indexedDB */

const DB_NAME = "gotonghr-ess";
const OUTBOX = "outbox_clock_events";
const OWNER = "sync_control";
const BOOTSTRAP = "bootstrap_cache";

let opening = null;

export function openDb() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: "idempotency_key" });
      }
      if (!db.objectStoreNames.contains(OWNER)) {
        db.createObjectStore(OWNER, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(BOOTSTRAP)) {
        db.createObjectStore(BOOTSTRAP, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error ?? new Error("IndexedDB did not open."));
    };
  });
  return opening;
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
  });
}

async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await transactionDone(tx);
}

export function putOutbox(event) {
  return put(OUTBOX, event);
}

export async function listOutbox() {
  const db = await openDb();
  const tx = db.transaction(OUTBOX, "readonly");
  const rows = await requestDone(tx.objectStore(OUTBOX).getAll());
  rows.sort((left, right) => String(left.captured_at).localeCompare(String(right.captured_at)));
  return rows;
}

export async function deleteOutbox(key) {
  const db = await openDb();
  const tx = db.transaction(OUTBOX, "readwrite");
  tx.objectStore(OUTBOX).delete(key);
  await transactionDone(tx);
}

export function writeOwnerBeat() {
  return put(OWNER, { id: "owner", holder: "page", beat: Date.now() });
}

export async function readOwnerBeat() {
  const db = await openDb();
  const tx = db.transaction(OWNER, "readonly");
  const row = await requestDone(tx.objectStore(OWNER).get("owner"));
  return row && typeof row.beat === "number" ? row.beat : null;
}

export function writeBootstrap(record) {
  return put(BOOTSTRAP, record);
}

export async function readBootstrap() {
  const db = await openDb();
  const tx = db.transaction(BOOTSTRAP, "readonly");
  const row = await requestDone(tx.objectStore(BOOTSTRAP).get("current"));
  return row ?? null;
}
