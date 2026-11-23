/**
 * The user's own parts, kept in the browser's IndexedDB so they survive a
 * reload and can be reused across designs.
 *
 * Database `wiring-design`, version 2, four object stores:
 * - `parts`:  part definitions, keyed by part id;
 * - `models`: GLB files of custom models, keyed by their sha256 (the part's
 *   `model.uri` is `custom:<sha256>`), so parts sharing a model share a file;
 * - `cache`:  small strings keyed by any string (rendered thumbnails);
 * - `cables`: the user's own cable types (version 2), keyed by type id; each
 *   type carries the parameters it was built from (`type.spec`).
 *
 * Reads resolve to an empty or undefined result when IndexedDB is missing or
 * refuses to open (Node, some private windows). WRITES of parts and cables
 * reject with a `StoreError` in plain words whenever nothing was written, so
 * the app never says something was kept when it was not; the thumbnail cache
 * is best effort and never rejects. While another tab blocks an upgrade, the
 * lists wait for it (and `onDbStatus` says why) and the cache is skipped.
 * Each function takes the IndexedDB factory as an optional last argument so
 * tests can pass `fake-indexeddb`.
 */
import { CableSpecSchema, CableTypeSchema, PartSchema, type CableType, type Part } from '@core';
import { sha256Hex } from './glb';

const DB_NAME = 'wiring-design';
const DB_VERSION = 2;
const PARTS = 'parts';
const MODELS = 'models';
const CACHE = 'cache';
const CABLES = 'cables';

/** What the database is doing, for the app to tell the user. */
export type DbStatus = 'open' | 'blocked' | 'unavailable';
const statusListeners = new Set<(status: DbStatus, detail: string) => void>();
const statusOf = new WeakMap<IDBFactory, DbStatus>();

/** Be told when the database opens, is held up by another tab, or cannot be used. Returns an unsubscribe. */
export function onDbStatus(cb: (status: DbStatus, detail: string) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function setStatus(idb: IDBFactory, status: DbStatus, detail: string): void {
  if (statusOf.get(idb) === status) return;
  statusOf.set(idb, status);
  for (const cb of statusListeners) cb(status, detail);
}

/** Why something could not be stored, in plain words (thrown by every write of parts and cables). */
export class StoreError extends Error {}

const UNAVAILABLE = 'This browser does not let the app keep anything on this PC (storage is turned off, or this is a private window).';
const BLOCKED = 'Another tab of this app is open with an older version of its storage. Close that tab (or reload it) and this one carries on by itself.';

/** One open per factory, reused. A failed open is forgotten so a later call may retry. */
const opened = new WeakMap<IDBFactory, Promise<IDBDatabase | undefined>>();

function defaultFactory(): IDBFactory | undefined {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined;
  } catch {
    return undefined; // some browsers throw on access when storage is blocked
  }
}

/**
 * Open the database (creating or upgrading it). While another tab holds an
 * older version open the upgrade is BLOCKED: the open stays pending (it goes
 * on as soon as that tab lets go) and `onDbStatus` is told, so the app can
 * say so instead of showing empty lists. Every connection closes itself when
 * another tab wants to upgrade, so this tab never blocks a newer one.
 */
function openDb(factory: IDBFactory | undefined): Promise<IDBDatabase | undefined> {
  const idb = factory ?? defaultFactory();
  if (!idb) return Promise.resolve(undefined);
  let db = opened.get(idb);
  if (!db) {
    db = new Promise<IDBDatabase | undefined>((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = idb.open(DB_NAME, DB_VERSION);
      } catch {
        setStatus(idb, 'unavailable', UNAVAILABLE);
        resolve(undefined);
        return;
      }
      request.onupgradeneeded = () => {
        const d = request.result;
        for (const name of [PARTS, MODELS, CACHE, CABLES]) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
      };
      request.onsuccess = () => {
        const d = request.result;
        // Another tab upgrading the database: let it, and open again next time.
        d.onversionchange = () => {
          d.close();
          opened.delete(idb);
        };
        setStatus(idb, 'open', '');
        resolve(d);
      };
      request.onerror = () => {
        setStatus(idb, 'unavailable', `${UNAVAILABLE} (${request.error?.message ?? 'the database did not open'})`);
        resolve(undefined);
      };
      // Not a failure: the open completes when the other tab lets go. Say so meanwhile.
      request.onblocked = () => setStatus(idb, 'blocked', BLOCKED);
    });
    opened.set(idb, db);
    void db.then((d) => {
      if (!d) opened.delete(idb);
    });
  }
  return db;
}

/** True while the open is held up by another tab (reads that must not wait, such as the thumbnail cache, skip then). */
function isBlocked(factory: IDBFactory | undefined): boolean {
  const idb = factory ?? defaultFactory();
  return !!idb && statusOf.get(idb) === 'blocked';
}

/** Run `body` in one transaction; resolves with its result when the transaction completes, or `fallback` on any failure. For reads. */
async function withStores<T>(
  factory: IDBFactory | undefined,
  stores: string[],
  mode: IDBTransactionMode,
  fallback: T,
  body: (tx: IDBTransaction) => () => T,
): Promise<T> {
  try {
    return await transact(factory, stores, mode, body);
  } catch {
    return fallback;
  }
}

/**
 * Run `body` in one transaction; resolves with its result once the
 * transaction has COMMITTED, and rejects with a `StoreError` in plain words
 * when nothing was written (no storage, an open that failed, an error or an
 * abort such as a full disk). For writes.
 */
async function transact<T>(factory: IDBFactory | undefined, stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => () => T): Promise<T> {
  // A write must not wait, unseen, for another tab to let go.
  if (mode === 'readwrite' && isBlocked(factory)) throw new StoreError(BLOCKED);
  const db = await openDb(factory);
  if (!db) throw new StoreError(UNAVAILABLE);
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    let result: () => T;
    try {
      tx = db.transaction(stores, mode);
      result = body(tx);
    } catch (e) {
      reject(new StoreError(`It could not be stored on this PC: ${e instanceof Error ? e.message : String(e)}.`));
      return;
    }
    tx.oncomplete = () => {
      try {
        resolve(result());
      } catch (e) {
        reject(new StoreError(`It could not be read back: ${e instanceof Error ? e.message : String(e)}.`));
      }
    };
    const fail = () => {
      const why = tx.error?.name === 'QuotaExceededError' ? 'the browser has no more room for this site' : (tx.error?.message ?? 'the browser cancelled the write');
      reject(new StoreError(`It could not be stored on this PC: ${why}.`));
    };
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

/** The read result of a request, once its transaction has completed. */
function resultOf<T>(request: IDBRequest): () => T {
  return () => request.result as T;
}

/** The sha256 a custom model is stored under, from `custom:<sha>` or `model.sha256`. */
function customSha(part: Part): string | undefined {
  const uri = part.model?.uri;
  if (uri?.startsWith('custom:')) return uri.slice('custom:'.length);
  return undefined;
}

/** Every stored custom part, by name. Entries that no longer pass `PartSchema` are skipped. */
export async function listCustomParts(idb?: IDBFactory): Promise<Part[]> {
  const raw = await withStores<unknown[]>(idb, [PARTS], 'readonly', [], (tx) => resultOf(tx.objectStore(PARTS).getAll()));
  const parts: Part[] = [];
  for (const r of raw) {
    const parsed = PartSchema.safeParse(r);
    if (parsed.success) parts.push(parsed.data);
  }
  return parts.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/**
 * Store a part (replacing one with the same id) and, when given, its GLB
 * under the sha256 its `model.uri` names (computed from the file when the uri
 * does not say). Throws only when the part is not a valid `Part`.
 */
export async function saveCustomPart(part: Part, glb?: ArrayBuffer, idb?: IDBFactory): Promise<void> {
  const valid = PartSchema.parse(part);
  const sha = glb ? (customSha(valid) ?? valid.model?.sha256 ?? (await sha256Hex(glb))) : undefined;
  await transact(idb, glb ? [PARTS, MODELS] : [PARTS], 'readwrite', (tx) => {
    tx.objectStore(PARTS).put(valid, valid.id);
    if (glb && sha) tx.objectStore(MODELS).put(glb, sha);
    return () => undefined;
  });
}

/** Replace a stored part's definition, keeping the stored model file. Throws only on an invalid part. */
export async function updateCustomPart(part: Part, idb?: IDBFactory): Promise<void> {
  await saveCustomPart(part, undefined, idb);
}

/** Remove a part, and its model file when no other stored part uses it. */
export async function deleteCustomPart(id: string, idb?: IDBFactory): Promise<void> {
  const all = await withStores<unknown[]>(idb, [PARTS], 'readonly', [], (tx) => resultOf(tx.objectStore(PARTS).getAll()));
  const parts = all.map((r) => PartSchema.safeParse(r)).flatMap((p) => (p.success ? [p.data] : []));
  const gone = parts.find((p) => p.id === id);
  const sha = gone ? customSha(gone) : undefined;
  const stillUsed = sha !== undefined && parts.some((p) => p.id !== id && customSha(p) === sha);
  await transact(idb, [PARTS, MODELS], 'readwrite', (tx) => {
    tx.objectStore(PARTS).delete(id);
    if (sha && !stillUsed) tx.objectStore(MODELS).delete(sha);
    return () => undefined;
  });
}

/** The GLB stored under `sha256`, or undefined. */
export async function loadCustomModel(sha256: string, idb?: IDBFactory): Promise<ArrayBuffer | undefined> {
  const r = await withStores<unknown>(idb, [MODELS], 'readonly', undefined, (tx) => resultOf(tx.objectStore(MODELS).get(sha256)));
  return r instanceof ArrayBuffer ? r : undefined;
}

/** A cached string, or undefined. */
export async function cacheGet(key: string, idb?: IDBFactory): Promise<string | undefined> {
  if (isBlocked(idb)) return undefined; // never make a thumbnail wait for another tab
  const r = await withStores<unknown>(idb, [CACHE], 'readonly', undefined, (tx) => resultOf(tx.objectStore(CACHE).get(key)));
  return typeof r === 'string' ? r : undefined;
}

/** Drop a cached string (best effort). */
export async function cacheDelete(key: string, idb?: IDBFactory): Promise<void> {
  if (isBlocked(idb)) return;
  await withStores(idb, [CACHE], 'readwrite', undefined, (tx) => {
    tx.objectStore(CACHE).delete(key);
    return () => undefined;
  });
}

/** Cache a string under `key`, replacing what was there. */
export async function cacheSet(key: string, value: string, idb?: IDBFactory): Promise<void> {
  if (isBlocked(idb)) return;
  await withStores(idb, [CACHE], 'readwrite', undefined, (tx) => {
    tx.objectStore(CACHE).put(value, key);
    return () => undefined;
  });
}

/**
 * A user's cable type as stored. The type carries the parameters it was
 * built from (`type.spec`); a record written before that kept them beside it
 * (`{ type, spec }`), and is brought forward on read.
 */
export interface StoredCable {
  type: CableType;
}

/** One stored record, brought forward. Undefined only when the TYPE itself is not valid. */
export function readCableRecord(raw: unknown): StoredCable | undefined {
  const rec = raw as { type?: unknown; spec?: unknown } | null;
  const type = CableTypeSchema.safeParse(rec?.type);
  if (!type.success) return undefined;
  if (type.data.spec || rec?.spec === undefined) return { type: type.data };
  // An older record: the parameters were kept beside the type. Keep them when they are still valid; never drop the type.
  const spec = CableSpecSchema.safeParse(rec.spec);
  return { type: spec.success ? { ...type.data, spec: spec.data } : type.data };
}

/** Every stored cable type, by name. A record is left out only when its type is not valid. */
export async function listCustomCables(idb?: IDBFactory): Promise<StoredCable[]> {
  const raw = await withStores<unknown[]>(idb, [CABLES], 'readonly', [], (tx) => resultOf(tx.objectStore(CABLES).getAll()));
  return raw
    .map(readCableRecord)
    .filter((c): c is StoredCable => !!c)
    .sort((a, b) => a.type.name.localeCompare(b.type.name) || (a.type.id < b.type.id ? -1 : 1));
}

/** Store a cable type, replacing one with the same id. Rejects when it is not valid or was not written. */
export async function saveCustomCable(cable: StoredCable, idb?: IDBFactory): Promise<void> {
  const type = CableTypeSchema.parse(cable.type);
  await transact(idb, [CABLES], 'readwrite', (tx) => {
    tx.objectStore(CABLES).put({ type }, type.id);
    return () => undefined;
  });
}

/** Remove a stored cable type. Rejects when storage failed. */
export async function deleteCustomCable(id: string, idb?: IDBFactory): Promise<void> {
  await transact(idb, [CABLES], 'readwrite', (tx) => {
    tx.objectStore(CABLES).delete(id);
    return () => undefined;
  });
}
