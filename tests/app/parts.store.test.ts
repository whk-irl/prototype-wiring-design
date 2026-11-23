import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { PartSchema, type Part } from '@core';
import { cacheGet, cacheSet, deleteCustomPart, listCustomParts, loadCustomModel, saveCustomPart, updateCustomPart } from '../../src/app/parts/store';

const SHA = 'c'.repeat(64);

function part(id: string, name: string, sha = SHA): Part {
  return PartSchema.parse({
    id,
    name,
    category: 'sensor',
    body: { size_mm: [10, 10, 3] },
    model: { uri: `custom:${sha}`, sha256: sha, triangles: 12 },
    confidence: 'measured',
    custom: true,
  });
}

const bytes = (...v: number[]): ArrayBuffer => Uint8Array.from(v).buffer;

describe('custom part store', () => {
  it('saves, lists, updates and deletes parts with their models', async () => {
    const idb = new IDBFactory();
    expect(await listCustomParts(idb)).toEqual([]);
    await saveCustomPart(part('custom-b-1', 'Bravo'), bytes(1, 2, 3), idb);
    await saveCustomPart(part('custom-a-1', 'Alpha'), undefined, idb);
    expect((await listCustomParts(idb)).map((p) => p.name)).toEqual(['Alpha', 'Bravo']);
    expect(new Uint8Array((await loadCustomModel(SHA, idb))!)).toEqual(Uint8Array.from([1, 2, 3]));

    // Updating the definition keeps the stored model.
    await updateCustomPart({ ...part('custom-b-1', 'Bravo 2') }, idb);
    expect((await listCustomParts(idb)).map((p) => p.name)).toEqual(['Alpha', 'Bravo 2']);
    expect(await loadCustomModel(SHA, idb)).toBeDefined();

    // Alpha shares the model: deleting Bravo keeps the file, deleting Alpha too removes it.
    await deleteCustomPart('custom-b-1', idb);
    expect(await loadCustomModel(SHA, idb)).toBeDefined();
    await deleteCustomPart('custom-a-1', idb);
    expect(await listCustomParts(idb)).toEqual([]);
    expect(await loadCustomModel(SHA, idb)).toBeUndefined();
  });

  it('stores a model under the sha its uri names', async () => {
    const idb = new IDBFactory();
    const sha = 'd'.repeat(64);
    await saveCustomPart(part('custom-x-1', 'X', sha), bytes(9), idb);
    expect(await loadCustomModel(sha, idb)).toBeDefined();
    expect(await loadCustomModel(SHA, idb)).toBeUndefined();
  });

  it('keeps cached strings', async () => {
    const idb = new IDBFactory();
    expect(await cacheGet('thumb:a', idb)).toBeUndefined();
    await cacheSet('thumb:a', 'data:image/png;base64,AAAA', idb);
    await cacheSet('thumb:a', 'data:image/png;base64,BBBB', idb);
    expect(await cacheGet('thumb:a', idb)).toBe('data:image/png;base64,BBBB');
  });

  it('rejects an invalid part instead of storing it', async () => {
    const idb = new IDBFactory();
    await expect(saveCustomPart({ ...part('custom-a-1', 'A'), id: 'bad id!' }, undefined, idb)).rejects.toThrow();
    expect(await listCustomParts(idb)).toEqual([]);
  });

  it('without IndexedDB (Node): reads come back empty, the cache is skipped, and a write is refused', async () => {
    expect('indexedDB' in globalThis).toBe(false);
    expect(await listCustomParts()).toEqual([]);
    expect(await loadCustomModel(SHA)).toBeUndefined();
    expect(await cacheGet('k')).toBeUndefined();
    await expect(cacheSet('k', 'v')).resolves.toBeUndefined();
    // A write that stored nothing must not look like one that did.
    await expect(saveCustomPart(part('custom-a-1', 'A'), bytes(1))).rejects.toThrow();
    await expect(deleteCustomPart('x')).rejects.toThrow();
  });
});
