/** Node path (tests, tools): run occt-import-js directly on the calling thread. */
import type { OcctModule } from 'occt-import-js';
import { tessellate, type OcctKind, type OcctTessellation } from './occt';

let cached: Promise<OcctModule> | null = null;

export async function tessellateInNode(kind: OcctKind, data: ArrayBuffer): Promise<OcctTessellation> {
  cached ??= import('occt-import-js').then((m) => {
    const factory = ((m as { default?: unknown }).default ?? m) as () => Promise<OcctModule>;
    return factory();
  });
  const occt = await cached;
  return tessellate(occt, kind, new Uint8Array(data));
}
