/**
 * Ids of the user's own parts. Every user part id starts with `custom-`, so
 * it can never be a bundled part's id (bundled ids never start with it) and
 * is recognisable anywhere it appears (designs, part files, the store).
 */
import { slugify } from '../parts/fromModel';

export const CUSTOM_PREFIX = 'custom-';

export function isCustomId(id: string): boolean {
  return id.startsWith(CUSTOM_PREFIX);
}

/** A new id for a user part: `custom-<name slug>-<8 random hex>`. */
export function newCustomId(name: string): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${CUSTOM_PREFIX}${slugify(name) || 'part'}-${hex}`;
}
