// Хранилище в IndexedDB. Данные живут только на устройстве.
import { defaultCategories } from './logic.js';

const DB_NAME = 'budget';
const STORES = ['transactions', 'categories', 'goals', 'meta'];
let db;

const req = (r) => new Promise((ok, fail) => {
  r.onsuccess = () => ok(r.result);
  r.onerror = () => fail(r.error);
});

const done = (tx) => new Promise((ok, fail) => {
  tx.oncomplete = () => ok();
  tx.onerror = () => fail(tx.error);
  tx.onabort = () => fail(tx.error);
});

export async function openDB() {
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    for (const s of ['transactions', 'categories', 'goals']) open.result.createObjectStore(s, { keyPath: 'id' });
    open.result.createObjectStore('meta');
  };
  db = await req(open);
  if ((await req(db.transaction('categories').objectStore('categories').count())) === 0) {
    await putMany('categories', defaultCategories());
  }
}

export const getAll = (store) => req(db.transaction(store).objectStore(store).getAll());
export const getMeta = (key) => req(db.transaction('meta').objectStore('meta').get(key));

export async function putMany(store, items) {
  const tx = db.transaction(store, 'readwrite');
  for (const item of items) tx.objectStore(store).put(item);
  await done(tx);
}

export const put = (store, item) => putMany(store, [item]);

export async function remove(store, id) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  await done(tx);
}

export async function setMeta(key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await done(tx);
}

/** Полная замена данных одной транзакцией: при сбое старые данные останутся. */
export async function replaceAll(data) {
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of ['transactions', 'categories', 'goals']) {
    tx.objectStore(s).clear();
    for (const item of data[s]) tx.objectStore(s).put(item);
  }
  tx.objectStore('meta').put(data.rules || {}, 'rules');
  await done(tx);
}
