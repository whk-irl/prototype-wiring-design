/** Parsers for plain mesh files: STL, OBJ, GLB/GLTF. Each returns parts in the file's own unit. */
import { Matrix4, Mesh, type BufferGeometry, type Material } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { fileNameOf, extensionOf } from './ids';
import { DEFAULT_COLOR, findByPathSuffix, type ParsedPart } from './model';
import type { ImportFile } from './types';

/** glTF is Y-up, the app is Z-up: (x, y, z) -> (x, -z, y). */
const Y_UP_TO_Z_UP = new Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1);

/** Read an attribute through its accessors: handles interleaving, normalisation and any component type. */
function readAttribute(attr: { count: number; itemSize: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }): Float64Array {
  const out = new Float64Array(attr.count * 3);
  for (let i = 0; i < attr.count; i++) {
    out[3 * i] = attr.getX(i);
    out[3 * i + 1] = attr.getY(i);
    out[3 * i + 2] = attr.getZ(i);
  }
  return out;
}

function rawOf(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();
  let idx: Uint32Array | null = null;
  if (index) {
    idx = new Uint32Array(index.count);
    for (let i = 0; i < index.count; i++) idx[i] = index.getX(i);
  }
  return { positions: position ? readAttribute(position) : new Float64Array(0), index: idx };
}

export function parseStl(file: ImportFile): ParsedPart[] {
  const geometry = new STLLoader().parse(file.data);
  const name = fileNameOf(file.path).replace(/\.[^.]*$/, '') || 'mesh';
  return [{ name, node: fileNameOf(file.path), color: [...DEFAULT_COLOR], raw: rawOf(geometry) }];
}

export function parseObj(file: ImportFile): ParsedPart[] {
  const text = new TextDecoder().decode(file.data);
  const group = new OBJLoader().parse(text);
  const parts: ParsedPart[] = [];
  const fallback = fileNameOf(file.path).replace(/\.[^.]*$/, '') || 'mesh';
  group.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const name = o.name || (o.parent && o.parent.name) || fallback;
    parts.push({ name, node: name, color: [...DEFAULT_COLOR], raw: rawOf(o.geometry as BufferGeometry) });
  });
  return parts;
}

// ---------------------------------------------------------------- glTF

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;

interface GltfJson {
  textures?: unknown;
  images?: unknown;
  samplers?: unknown;
  buffers?: { uri?: string; byteLength: number }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [key: string]: unknown;
}

/** Remove everything texture related, so that the loader never needs images or a DOM. Returns true if anything changed. */
function stripTextures(json: GltfJson): boolean {
  let changed = false;
  for (const key of ['textures', 'images', 'samplers'] as const) {
    if (json[key] !== undefined) {
      delete json[key];
      changed = true;
    }
  }
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (/Texture$/.test(k) && v && typeof v === 'object' && 'index' in v) {
          delete obj[k];
          changed = true;
        } else walk(v);
      }
    }
  };
  walk(json['materials']);
  const textureExt = /texture|webp|basisu|avif/i;
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json[key];
    if (list) json[key] = list.filter((e) => !textureExt.test(e));
  }
  return changed;
}

function checkExtensions(json: GltfJson): void {
  const unsupported = (json.extensionsRequired ?? []).filter((e) => /draco|meshopt|spz|gaussian/i.test(e));
  if (unsupported.length > 0) {
    throw new Error(`This glTF file uses compression this app cannot read (${unsupported.join(', ')}). Export it without compression.`);
  }
}

/** Returns what to hand to `GLTFLoader.parse`. */
function prepareGltf(file: ImportFile, all: ImportFile[]): ArrayBuffer | string {
  const head = new DataView(file.data);
  const isGlb = file.data.byteLength >= 12 && head.getUint32(0, true) === GLB_MAGIC;
  if (isGlb) {
    const jsonLen = head.getUint32(12, true);
    if (head.getUint32(16, true) !== CHUNK_JSON || 20 + jsonLen > file.data.byteLength) throw new Error('The GLB file is damaged (no JSON chunk).');
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(file.data, 20, jsonLen))) as GltfJson;
    checkExtensions(json);
    if (!stripTextures(json)) return file.data;
    const enc = new TextEncoder().encode(JSON.stringify(json));
    const padded = new Uint8Array(Math.ceil(enc.length / 4) * 4).fill(0x20);
    padded.set(enc);
    const rest = new Uint8Array(file.data, 20 + jsonLen);
    const out = new Uint8Array(20 + padded.length + rest.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, GLB_MAGIC, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, out.length, true);
    dv.setUint32(12, padded.length, true);
    dv.setUint32(16, CHUNK_JSON, true);
    out.set(padded, 20);
    out.set(rest, 20 + padded.length);
    return out.buffer;
  }
  const json = JSON.parse(new TextDecoder().decode(file.data)) as GltfJson;
  checkExtensions(json);
  stripTextures(json);
  // The loader fetches buffer URIs, which does not work everywhere (Node). Pack
  // every buffer into one GLB binary chunk instead.
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let total = 0;
  for (const buffer of json.buffers ?? []) {
    let bytes: Uint8Array;
    if (!buffer.uri) throw new Error('The glTF file has a buffer without data.');
    if (buffer.uri.startsWith('data:')) {
      const comma = buffer.uri.indexOf(',');
      const body = buffer.uri.slice(comma + 1);
      bytes = /;base64$/i.test(buffer.uri.slice(0, comma)) ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body));
    } else {
      const match = findByPathSuffix(decodeURIComponent(buffer.uri), all.filter((f) => f !== file));
      if (!match) throw new Error(`The glTF file refers to "${buffer.uri}", which was not supplied. Add it, or use a GLB file.`);
      bytes = new Uint8Array(match.data);
    }
    offsets.push(total);
    chunks.push(bytes);
    total += Math.ceil(bytes.length / 4) * 4;
  }
  const bin = new Uint8Array(total);
  chunks.forEach((c, i) => bin.set(c, offsets[i]!));
  const views = (json['bufferViews'] ?? []) as { buffer: number; byteOffset?: number }[];
  for (const v of views) {
    v.byteOffset = (v.byteOffset ?? 0) + (offsets[v.buffer] ?? 0);
    v.buffer = 0;
  }
  json.buffers = [{ byteLength: total }];
  return packGlb(json, bin);
}

function packGlb(json: GltfJson, bin: Uint8Array): ArrayBuffer {
  const enc = new TextEncoder().encode(JSON.stringify(json));
  const jsonChunk = new Uint8Array(Math.ceil(enc.length / 4) * 4).fill(0x20);
  jsonChunk.set(enc);
  const out = new Uint8Array(12 + 8 + jsonChunk.length + (bin.length ? 8 + bin.length : 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonChunk.length, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonChunk, 20);
  if (bin.length) {
    dv.setUint32(20 + jsonChunk.length, bin.length, true);
    dv.setUint32(24 + jsonChunk.length, 0x004e4942, true);
    out.set(bin, 28 + jsonChunk.length);
  }
  return out.buffer;
}

export async function parseGltf(file: ImportFile, all: ImportFile[]): Promise<ParsedPart[]> {
  const input = prepareGltf(file, all);
  const gltf = await new Promise<{ scene: import('three').Object3D }>((resolve, reject) => {
    new GLTFLoader().parse(input, '', (g) => resolve(g), (e) => reject(e instanceof Error ? e : new Error(String((e as { message?: string })?.message ?? e))));
  });
  gltf.scene.updateMatrixWorld(true);
  const parts: ParsedPart[] = [];
  const fallback = fileNameOf(file.path).replace(/\.[^.]*$/, '') || 'mesh';
  gltf.scene.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geometry = o.geometry as BufferGeometry;
    const names: string[] = [];
    for (let n: import('three').Object3D | null = o; n && n !== gltf.scene; n = n.parent) if (n.name) names.unshift(n.name);
    const material = (Array.isArray(o.material) ? o.material[0] : o.material) as (Material & { color?: { r: number; g: number; b: number } }) | undefined;
    const c = material?.color;
    const raw = rawOf(geometry);
    const normal = geometry.getAttribute('normal');
    parts.push({
      name: o.name || names[names.length - 1] || fallback,
      node: names.join('/') || fallback,
      color: c ? [c.r, c.g, c.b] : [...DEFAULT_COLOR],
      raw: { ...raw, normals: normal ? readAttribute(normal) : null },
      keepNormals: true,
      matrix: new Matrix4().multiplyMatrices(Y_UP_TO_Z_UP, o.matrixWorld),
    });
  });
  return parts;
}

/** Parse one mesh file by extension. Used for the top-level file and for URDF mesh references. */
export async function parseMeshFile(file: ImportFile, all: ImportFile[]): Promise<ParsedPart[] | null> {
  switch (extensionOf(file.path)) {
    case 'stl':
      return parseStl(file);
    case 'obj':
      return parseObj(file);
    case 'glb':
    case 'gltf':
      return parseGltf(file, all);
    default:
      return null;
  }
}
