/**
 * Id helpers. Ids must satisfy `IdSchema`: start with a letter or digit, then
 * letters, digits and `_ . : -`, at most 128 characters.
 */

const MAX_ID = 128;

/** Replace characters `IdSchema` does not allow and make sure the result starts with a letter or digit. */
export function sanitizeIdPart(raw: string, fallback = 'x'): string {
  let s = raw.normalize('NFKD').replace(/[^A-Za-z0-9_.:-]+/g, '_');
  s = s.replace(/^[^A-Za-z0-9]+/, '');
  return s.length > 0 ? s : fallback;
}

/** 32-bit FNV-1a, as 8 hex digits. Only used to keep over-long ids unique. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Join id parts with `.`, sanitising each, and shorten (with a hash suffix) if longer than 128. */
export function makeId(...parts: string[]): string {
  const id = parts.map((p) => sanitizeIdPart(p)).join('.');
  if (id.length <= MAX_ID) return id;
  return `${id.slice(0, MAX_ID - 9)}_${fnv1a(id)}`;
}

export function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

export function extensionOf(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Default id prefix from a file path: the file name without its extension. */
export function defaultPrefix(path: string): string {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return sanitizeIdPart(base, 'model').slice(0, 48);
}

/**
 * Sanitise first, then make unique: an id from `parts` that is not in `used`
 * (and is added to it). Colliding ids get `_2`, `_3`, ... on the last part, in
 * call order, so the same file always yields the same ids.
 */
export function uniqueId(used: Set<string>, ...parts: string[]): string {
  let id = makeId(...parts);
  const head = parts.slice(0, -1);
  const last = sanitizeIdPart(parts[parts.length - 1] ?? '');
  for (let n = 2; used.has(id); n++) id = makeId(...head, `${last}_${n}`);
  used.add(id);
  return id;
}

/** Returns `base` the first time and `base_2`, `base_3`, ... after that. */
export function uniqueName(used: Set<string>, base: string): string {
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
