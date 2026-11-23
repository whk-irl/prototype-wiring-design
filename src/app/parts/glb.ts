/**
 * Part model files: one GLB per part (see `PartModelSchema`).
 *
 * Frames. A part's geometry is held in millimetres in the PART frame (Z-up,
 * origin at the centre of the mounting face). The GLB follows glTF: metres,
 * +Y up. The app maps glTF (x, y, z) to part millimetres (x, -z, y), so
 * writing does the inverse: part (x, y, z) mm -> glTF (x, z, -y) / 1000.
 *
 * The writer is hand-made (JSON chunk + BIN chunk) so that it runs in a
 * browser, a Web Worker and Node alike, with no three.js exporter and no DOM.
 * The reader handles what the writer produces and plain, uncompressed GLBs
 * from other tools; it ignores textures and refuses compressed geometry.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Part } from '@core';

/** One triangle mesh of a part, in millimetres in the part frame. */
export interface PartMesh {
  name: string;
  /** x, y, z per vertex, mm, part frame. */
  positions: Float32Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
  /** Display colour, linear RGB 0..1. */
  color?: [number, number, number];
}

/** Concatenate meshes into one (vertices appended, indices offset); name and colour from `template`. */
export function joinMeshes(template: PartMesh, pieces: readonly PartMesh[]): PartMesh {
  if (pieces.length === 1) return { ...template, positions: pieces[0]!.positions, indices: pieces[0]!.indices };
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of pieces) {
    vertexCount += p.positions.length / 3;
    indexCount += p.indices.length;
  }
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let i = 0;
  for (const p of pieces) {
    positions.set(p.positions, v * 3);
    for (let k = 0; k < p.indices.length; k++) indices[i + k] = p.indices[k]! + v;
    v += p.positions.length / 3;
    i += p.indices.length;
  }
  return { ...template, positions, indices };
}

/** Most vertices in one merged mesh, so its indices still fit in 16 bits. */
const MERGE_MAX_VERTICES = 0xfffe;

/**
 * Merge meshes of the same colour into as few meshes as possible, each below
 * 65535 vertices so it keeps 16-bit indices. A file of hundreds of small
 * bodies then needs a few nodes, accessors and buffer views instead of
 * hundreds (the JSON for each costs about 250 bytes). Body names are lost:
 * merged meshes are named `colour 1`, `colour 2`, ... in order of first use.
 */
export function mergeByColour(meshes: readonly PartMesh[]): PartMesh[] {
  const groups = new Map<string, PartMesh[]>();
  for (const m of meshes) {
    if (m.indices.length < 3) continue;
    const key = m.color ? m.color.map((c) => c.toFixed(6)).join(',') : 'none';
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push(m);
  }
  const out: PartMesh[] = [];
  let colour = 0;
  for (const list of groups.values()) {
    colour++;
    const template: PartMesh = { name: `colour ${colour}`, positions: new Float32Array(0), indices: new Uint32Array(0) };
    if (list[0]!.color) template.color = list[0]!.color;
    let batch: PartMesh[] = [];
    let batchVertices = 0;
    const flush = () => {
      if (batch.length === 0) return;
      out.push(joinMeshes(template, batch));
      batch = [];
      batchVertices = 0;
    };
    for (const m of list) {
      const n = m.positions.length / 3;
      if (batchVertices + n > MERGE_MAX_VERTICES) flush();
      batch.push(m);
      batchVertices += n;
    }
    flush();
  }
  return out;
}

/** Key under which a part definition is embedded in a GLB (scene 0 `extras`). */
export const PART_EXTRAS_KEY = 'wiring_design_part';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const MM_PER_M = 1000;

// Caps on what a GLB may ask the reader to allocate. A part model is meant to
// be small (tens of thousands of triangles); these leave room for a large
// unsimplified CAD export while keeping memory to a few hundred MB at worst.
/** Values (elements x components) in one accessor. */
export const MAX_ACCESSOR_VALUES = 30_000_000;
/** Vertices over the whole file, counting every instance of a reused mesh. */
export const MAX_TOTAL_VERTICES = 10_000_000;
/** Triangle corners over the whole file (10 million triangles). */
export const MAX_TOTAL_INDICES = 30_000_000;
/** Nodes in the file. */
export const MAX_NODES = 1_000_000;

// glTF component types.
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;
// glTF buffer view targets.
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** Extensions that change how geometry is stored; this reader cannot decode them. */
const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco-compressed',
  EXT_meshopt_compression: 'meshopt-compressed',
  KHR_meshopt_compression: 'meshopt-compressed',
  KHR_mesh_quantization: 'quantised (KHR_mesh_quantization)',
};

// ---------------------------------------------------------------- glTF JSON (the parts we use)

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  extensions?: Record<string, unknown>;
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}
interface GltfMesh {
  name?: string;
  primitives: GltfPrimitive[];
}
interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number };
  doubleSided?: boolean;
}
interface GltfJson {
  asset: { version: string; generator?: string; extras?: Record<string, unknown> };
  scene?: number;
  scenes?: { name?: string; nodes?: number[]; extras?: Record<string, unknown> }[];
  nodes?: GltfNode[];
  meshes?: GltfMesh[];
  materials?: GltfMaterial[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { uri?: string; byteLength: number }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

// ---------------------------------------------------------------- writing

const align4 = (n: number): number => (n + 3) & ~3;

/** Write `meshes` (mm, part frame) as a GLB. `part`, when given, is embedded so the file stands alone. */
export function encodePartGlb(meshes: PartMesh[], part?: Part): ArrayBuffer {
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'Wiring Design part writer' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [],
  };
  const scene = json.scenes![0]!;
  if (part !== undefined) scene.extras = { [PART_EXTRAS_KEY]: part };

  // Lay out the binary chunk first: every buffer view starts on a 4-byte boundary.
  const pieces: { offset: number; bytes: Uint8Array }[] = [];
  let binLength = 0;
  const addView = (bytes: Uint8Array, target: number): number => {
    const offset = align4(binLength);
    pieces.push({ offset, bytes });
    binLength = offset + bytes.byteLength;
    json.bufferViews!.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    return json.bufferViews!.length - 1;
  };

  // One material per distinct colour; meshes without a colour share a neutral grey.
  const materialOf = new Map<string, number>();
  const material = (color: [number, number, number] | undefined): number => {
    const c = color ?? [0.5, 0.5, 0.5];
    const key = c.map((v) => v.toFixed(6)).join(',');
    let index = materialOf.get(key);
    if (index === undefined) {
      index = json.materials!.length;
      json.materials!.push({
        name: `colour ${json.materials!.length + 1}`,
        pbrMetallicRoughness: { baseColorFactor: [c[0], c[1], c[2], 1], metallicFactor: 0, roughnessFactor: 0.7 },
      });
      materialOf.set(key, index);
    }
    return index;
  };

  for (const mesh of meshes) {
    const nodeIndex = json.nodes!.length;
    scene.nodes!.push(nodeIndex);
    const vertexCount = Math.floor(mesh.positions.length / 3);
    if (vertexCount === 0 || mesh.indices.length < 3) {
      // glTF accessors must hold at least one element: an empty mesh keeps only its node (and name).
      json.nodes!.push({ name: mesh.name });
      continue;
    }

    // Part frame mm -> glTF metres, (x, y, z) -> (x, z, -y).
    const gltf = new Float32Array(vertexCount * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount; i++) {
      const x = mesh.positions[3 * i]! / MM_PER_M;
      const y = mesh.positions[3 * i + 1]! / MM_PER_M;
      const z = mesh.positions[3 * i + 2]! / MM_PER_M;
      gltf[3 * i] = x;
      gltf[3 * i + 1] = z;
      gltf[3 * i + 2] = -y + 0; // + 0 avoids writing -0
    }
    // min/max must match the stored float32 values exactly, so take them after rounding.
    for (let i = 0; i < gltf.length; i++) {
      const v = gltf[i]!;
      const k = i % 3;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
    const positionView = addView(new Uint8Array(gltf.buffer), ARRAY_BUFFER);
    const positionAccessor = json.accessors!.length;
    json.accessors!.push({ bufferView: positionView, componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max });

    // 0xffff is the primitive-restart value in some APIs, so 16-bit indices stop one short of it.
    const triangleIndexCount = mesh.indices.length - (mesh.indices.length % 3);
    const small = vertexCount < 0xffff;
    const indexArray = small ? Uint16Array.from(mesh.indices.subarray(0, triangleIndexCount)) : mesh.indices.slice(0, triangleIndexCount);
    const indexView = addView(new Uint8Array(indexArray.buffer, indexArray.byteOffset, indexArray.byteLength), ELEMENT_ARRAY_BUFFER);
    const indexAccessor = json.accessors!.length;
    json.accessors!.push({ bufferView: indexView, componentType: small ? UNSIGNED_SHORT : UNSIGNED_INT, count: triangleIndexCount, type: 'SCALAR' });

    const meshIndex = json.meshes!.length;
    json.meshes!.push({
      name: mesh.name,
      primitives: [{ attributes: { POSITION: positionAccessor }, indices: indexAccessor, material: material(mesh.color), mode: 4 }],
    });
    json.nodes!.push({ name: mesh.name, mesh: meshIndex });
  }

  const binPadded = align4(binLength);
  if (binPadded > 0) json.buffers!.push({ byteLength: binPadded });
  // Drop empty top-level arrays: the spec asks for arrays to have at least one element.
  for (const key of ['meshes', 'materials', 'accessors', 'bufferViews', 'buffers'] as const) {
    if (json[key]!.length === 0) delete json[key];
  }

  // JSON chunk padded with spaces, BIN chunk with zeros (both required by the spec).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = align4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonPadded + (binPadded > 0 ? 8 + binPadded : 0);
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, CHUNK_JSON, true);
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonPadded);
  if (binPadded > 0) {
    const binStart = 20 + jsonPadded;
    view.setUint32(binStart, binPadded, true);
    view.setUint32(binStart + 4, CHUNK_BIN, true);
    for (const piece of pieces) bytes.set(piece.bytes, binStart + 8 + piece.offset);
  }
  return out;
}

// ---------------------------------------------------------------- reading

/** Split a GLB into its JSON and (optional) binary chunk. */
function readChunks(data: ArrayBuffer): { json: GltfJson; bin?: Uint8Array } {
  if (data.byteLength < 20) throw new Error('Not a GLB file: it is too short.');
  const view = new DataView(data);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file: the header does not start with "glTF".');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB version ${version} is not supported; only glTF 2.0 is.`);
  const total = Math.min(view.getUint32(8, true), data.byteLength);
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  for (let at = 12; at + 8 <= total; ) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + length > total) throw new Error('The GLB file is truncated.');
    if (type === CHUNK_JSON && json === undefined) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, length))) as GltfJson;
    } else if (type === CHUNK_BIN && bin === undefined) {
      bin = new Uint8Array(data, start, length);
    }
    at = start + align4(length);
  }
  if (!json) throw new Error('The GLB file has no JSON chunk.');
  return { json, bin };
}

/** Throw a readable Error when the file stores geometry in a way this reader cannot decode. */
function refuseUnsupported(json: GltfJson): void {
  const used = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  for (const view of json.bufferViews ?? []) for (const name of Object.keys(view.extensions ?? {})) used.add(name);
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) for (const name of Object.keys(prim.extensions ?? {})) used.add(name);
  }
  for (const name of used) {
    const what = UNSUPPORTED_EXTENSIONS[name];
    if (what) throw new Error(`This GLB holds ${what} geometry (${name}), which cannot be read here. Export it again without compression.`);
  }
}

/** Decode a base64 `data:` URI buffer. Other external buffers are not available to a single-file reader. */
function dataUriBytes(uri: string): Uint8Array {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(uri);
  if (!match) throw new Error('The GLB refers to an external buffer file; only self-contained GLB files can be read.');
  const text = atob(match[1]!);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

class AccessorReader {
  private buffers: Uint8Array[];
  constructor(
    private json: GltfJson,
    bin: Uint8Array | undefined,
  ) {
    this.buffers = (json.buffers ?? []).map((b, i) => {
      if (b.uri !== undefined) return dataUriBytes(b.uri);
      if (i !== 0 || !bin) throw new Error('The GLB refers to a binary buffer it does not contain.');
      return bin;
    });
  }

  private accessor(index: number): GltfAccessor {
    const a = this.json.accessors?.[index];
    if (!a) throw new Error(`The GLB refers to accessor ${index}, which does not exist.`);
    if (a.sparse !== undefined) throw new Error('Sparse accessors are not supported.');
    return a;
  }

  /**
   * Check accessor `index` against its buffer view and buffer, and against the
   * caps, BEFORE anything is allocated. Returns where its data lies.
   */
  private locate(index: number): { a: GltfAccessor; components: number; size: number; buffer?: Uint8Array; base: number; stride: number } {
    const a = this.accessor(index);
    const components = COMPONENTS[a.type];
    const size = COMPONENT_BYTES[a.componentType];
    if (components === undefined || size === undefined) throw new Error(`Accessor ${index} has an unknown type.`);
    if (!Number.isInteger(a.count) || a.count < 0) throw new Error(`Accessor ${index} has an invalid count.`);
    if (a.count * components > MAX_ACCESSOR_VALUES) {
      throw new Error(`Accessor ${index} holds ${a.count} elements, more than this reader accepts (${MAX_ACCESSOR_VALUES} values).`);
    }
    if (a.bufferView === undefined) return { a, components, size, base: 0, stride: 0 };
    const viewDef = this.json.bufferViews?.[a.bufferView];
    if (!viewDef) throw new Error(`Accessor ${index} refers to a missing buffer view.`);
    const buffer = this.buffers[viewDef.buffer];
    if (!buffer) throw new Error(`Buffer view ${a.bufferView} refers to a missing buffer.`);
    const viewOffset = viewDef.byteOffset ?? 0;
    const accOffset = a.byteOffset ?? 0;
    const elementBytes = components * size;
    const stride = viewDef.byteStride ?? elementBytes;
    if (![viewOffset, accOffset, viewDef.byteLength, stride].every((v) => Number.isInteger(v) && v >= 0)) {
      throw new Error(`Accessor ${index} or its buffer view has a negative or fractional offset, length or stride.`);
    }
    if (stride < elementBytes) throw new Error(`Buffer view ${a.bufferView} has a stride smaller than one element.`);
    if (viewOffset + viewDef.byteLength > buffer.byteLength) throw new Error(`Buffer view ${a.bufferView} runs past the end of its buffer.`);
    if (a.count > 0 && accOffset + stride * (a.count - 1) + elementBytes > viewDef.byteLength) {
      throw new Error(`Accessor ${index} runs past the end of its buffer view.`);
    }
    return { a, components, size, buffer, base: buffer.byteOffset + viewOffset + accOffset, stride };
  }

  /** Number of elements in accessor `index`, checked. */
  count(index: number): number {
    return this.locate(index).a.count;
  }

  /** Read accessor `index` as numbers, honouring stride and offset. */
  private read(index: number): { values: Float64Array; components: number } {
    const { a, components, size, buffer, base, stride } = this.locate(index);
    const values = new Float64Array(a.count * components);
    if (!buffer) return { values, components }; // no buffer view: all zeros by the spec
    const dv = new DataView(buffer.buffer);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < components; c++) {
        const at = base + i * stride + c * size;
        let v: number;
        switch (a.componentType) {
          case 5120:
            v = dv.getInt8(at);
            break;
          case UNSIGNED_BYTE:
            v = dv.getUint8(at);
            break;
          case 5122:
            v = dv.getInt16(at, true);
            break;
          case UNSIGNED_SHORT:
            v = dv.getUint16(at, true);
            break;
          case UNSIGNED_INT:
            v = dv.getUint32(at, true);
            break;
          default:
            v = dv.getFloat32(at, true);
        }
        values[i * components + c] = v;
      }
    }
    return { values, components };
  }

  positions(index: number): Float64Array {
    const a = this.accessor(index);
    if (a.type !== 'VEC3' || a.componentType !== FLOAT) {
      throw new Error('Vertex positions are not 32-bit floats (quantised or compressed geometry), which cannot be read here.');
    }
    return this.read(index).values;
  }

  indices(index: number): Uint32Array {
    const a = this.accessor(index);
    if (a.type !== 'SCALAR' || ![UNSIGNED_BYTE, UNSIGNED_SHORT, UNSIGNED_INT].includes(a.componentType)) {
      throw new Error(`Accessor ${index} is not a valid index list.`);
    }
    return Uint32Array.from(this.read(index).values);
  }
}

/** Triangle list from any triangle primitive mode (4 list, 5 strip, 6 fan). Null for points and lines. */
function triangleList(mode: number, idx: Uint32Array): Uint32Array | null {
  if (mode === 4) return idx.subarray(0, idx.length - (idx.length % 3));
  if (mode !== 5 && mode !== 6) return null;
  const out: number[] = [];
  for (let i = 2; i < idx.length; i++) {
    if (mode === 5) {
      // Alternate the winding so every strip triangle faces the same way.
      if (i % 2 === 0) out.push(idx[i - 2]!, idx[i - 1]!, idx[i]!);
      else out.push(idx[i - 1]!, idx[i - 2]!, idx[i]!);
    } else {
      out.push(idx[0]!, idx[i - 1]!, idx[i]!);
    }
  }
  return Uint32Array.from(out);
}

function nodeMatrix(node: GltfNode): Matrix4 {
  const m = new Matrix4();
  if (node.matrix && node.matrix.length === 16) return m.fromArray(node.matrix); // column-major, like glTF
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return m.compose(new Vector3(t[0], t[1], t[2]), new Quaternion(r[0], r[1], r[2], r[3]), new Vector3(s[0], s[1], s[2]));
}

/**
 * Read a GLB into part meshes: mm, part frame, node transforms applied. One
 * `PartMesh` per primitive; a mesh with several primitives gives names
 * `name#1`, `name#2`, ... Points and lines are skipped. `part` is the embedded
 * part definition, unchecked: the caller validates it with `PartSchema`.
 */
export function decodePartGlb(data: ArrayBuffer): { meshes: PartMesh[]; part?: unknown } {
  const { json, bin } = readChunks(data);
  if (!json.asset || typeof json.asset.version !== 'string' || !json.asset.version.startsWith('2.')) {
    throw new Error('The GLB is not glTF 2.0.');
  }
  refuseUnsupported(json);
  const reader = new AccessorReader(json, bin);
  const nodes = json.nodes ?? [];
  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];

  // Roots: the scene's own list, or every node that is nobody's child when the file has no scene.
  let roots: number[];
  if (scene) roots = scene.nodes ?? [];
  else {
    const children = new Set(nodes.flatMap((n) => n.children ?? []));
    roots = nodes.map((_, i) => i).filter((i) => !children.has(i));
  }

  if (nodes.length > MAX_NODES) throw new Error(`The GLB has ${nodes.length} nodes, more than this reader accepts (${MAX_NODES}).`);
  const meshes: PartMesh[] = [];
  const visited = new Set<number>();
  let totalVertices = 0;
  let totalIndices = 0;
  // Depth-first with an explicit stack (a deep node chain must not overflow the call stack),
  // children in file order.
  const stack: { index: number; parent: Matrix4 }[] = [...roots].reverse().map((index) => ({ index, parent: new Matrix4() }));
  while (stack.length > 0) {
    const { index, parent } = stack.pop()!;
    const node = nodes[index];
    if (!node || visited.has(index)) continue; // a cycle, a shared child or a bad index: skip, do not loop
    visited.add(index);
    const world = new Matrix4().multiplyMatrices(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const gltfMesh = json.meshes?.[node.mesh];
      if (!gltfMesh) throw new Error(`Node ${index} refers to mesh ${node.mesh}, which does not exist.`);
      const baseName = node.name || gltfMesh.name || `mesh ${node.mesh}`;
      // A mirroring transform turns triangles inside out; swap two corners to keep them facing out.
      const mirrored = world.determinant() < 0;
      const e = world.elements;
      gltfMesh.primitives.forEach((prim, p) => {
        const posIndex = prim.attributes.POSITION;
        if (posIndex === undefined) return;
        const mode = prim.mode ?? 4;
        if (mode !== 4 && mode !== 5 && mode !== 6) return; // points and lines
        // Totals are checked before reading, so a hostile count never reaches an allocation.
        const vertexCount = reader.count(posIndex);
        const indexCount = prim.indices !== undefined ? reader.count(prim.indices) : vertexCount;
        totalVertices += vertexCount;
        totalIndices += mode === 4 ? indexCount : 3 * Math.max(0, indexCount - 2);
        if (totalVertices > MAX_TOTAL_VERTICES) throw new Error(`The GLB has more than ${MAX_TOTAL_VERTICES} vertices, more than this reader accepts.`);
        if (totalIndices > MAX_TOTAL_INDICES) throw new Error(`The GLB has more than ${MAX_TOTAL_INDICES / 3} triangles, more than this reader accepts.`);
        const src = reader.positions(posIndex);
        const raw = prim.indices !== undefined ? reader.indices(prim.indices) : Uint32Array.from({ length: vertexCount }, (_, i) => i);
        const tris = triangleList(mode, raw)!;
        for (const v of tris) if (v >= vertexCount) throw new Error(`Mesh "${baseName}" has an index past its last vertex.`);
        const indices = Uint32Array.from(tris);
        if (mirrored) {
          for (let t = 0; t + 2 < indices.length; t += 3) {
            const a = indices[t + 1]!;
            indices[t + 1] = indices[t + 2]!;
            indices[t + 2] = a;
          }
        }
        const positions = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
          const x = src[3 * i]!;
          const y = src[3 * i + 1]!;
          const z = src[3 * i + 2]!;
          // glTF world (metres, Y-up) ...
          const gx = e[0]! * x + e[4]! * y + e[8]! * z + e[12]!;
          const gy = e[1]! * x + e[5]! * y + e[9]! * z + e[13]!;
          const gz = e[2]! * x + e[6]! * y + e[10]! * z + e[14]!;
          // ... to part frame millimetres, (x, y, z) -> (x, -z, y).
          positions[3 * i] = gx * MM_PER_M;
          positions[3 * i + 1] = -gz * MM_PER_M + 0;
          positions[3 * i + 2] = gy * MM_PER_M;
        }
        const mesh: PartMesh = { name: gltfMesh.primitives.length > 1 ? `${baseName}#${p + 1}` : baseName, positions, indices };
        const factor = prim.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor : undefined;
        if (factor && factor.length >= 3) mesh.color = [factor[0]!, factor[1]!, factor[2]!];
        meshes.push(mesh);
      });
    }
    const children = node.children ?? [];
    for (let k = children.length - 1; k >= 0; k--) stack.push({ index: children[k]!, parent: world });
  }

  const part = scene?.extras?.[PART_EXTRAS_KEY] ?? json.asset.extras?.[PART_EXTRAS_KEY];
  return part === undefined ? { meshes } : { meshes, part };
}

/** SHA-256 of `data` as 64 lowercase hex digits (Web Crypto: browsers and Node 20+). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Total triangles over `meshes`. */
export function triangleCount(meshes: readonly PartMesh[]): number {
  let n = 0;
  for (const m of meshes) n += Math.floor(m.indices.length / 3);
  return n;
}

/** Axis-aligned bounds of one or more meshes, mm. Empty input gives min > max (Infinity / -Infinity). */
export function meshBounds(meshes: readonly PartMesh[]): { min_mm: [number, number, number]; max_mm: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    // Only vertices that a triangle uses count: a stray unused vertex is not part of the shape.
    for (const v of m.indices) {
      for (let k = 0; k < 3; k++) {
        const c = m.positions[3 * v + k]!;
        if (c < min[k]!) min[k] = c;
        if (c > max[k]!) max[k] = c;
      }
    }
  }
  return { min_mm: min, max_mm: max };
}
