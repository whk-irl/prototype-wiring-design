/**
 * A user part from a KiCad board file (`.kicad_pcb`, KiCad 6 to 9; KiCad 5
 * files mostly work too).
 *
 * What is read:
 * - the board outline: graphics on layer Edge.Cuts (lines, arcs, rectangles,
 *   circles, polygons, curves), board-level and inside footprints. The
 *   envelope uses its bounding box;
 * - the board thickness: `(general (thickness ...))`;
 * - mounting holes: footprints whose library name contains `MountingHole`;
 * - ports: connector footprints (library nickname starting `Connector`, or a
 *   reference starting J, P, CN, USB or X), with the connector family guessed
 *   from the footprint name.
 *
 * Frames. KiCad's board frame has +X to the right and +Y DOWN the screen, mm.
 * A footprint `(at x y a)` is rotated by `a` degrees counter-clockwise AS SEEN
 * ON SCREEN, so a footprint-local point (u, v) lands at
 *   (x + u cos a + v sin a,  y - u sin a + v cos a).
 * The part frame has +Y UP the screen (the board seen from its top side), +Z
 * out of the top copper, and its origin at the centre of the outline's
 * bounding box on the mounting face (the underside of whatever hangs below
 * the board). So part (x, y) = (kx - cx, -(ky - cy)).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { findConnector, type ConnectorLibrary, type Interface, type Part, type Port } from '@core';
import { slugify } from './fromModel';

// ---------------------------------------------------------------- S-expressions

/** An atom (quoted or bare, quotes removed) or a list. */
export type SExpr = string | SExpr[];

/** Longest text accepted, characters. Large real boards are a few MB; this keeps memory bounded. */
export const MAX_KICAD_TEXT = 64 * 1024 * 1024;
/** Deepest nesting accepted. KiCad files nest about 10 deep; anything near this is not a board. */
export const MAX_SEXPR_DEPTH = 256;

/** Parse KiCad's S-expression text (iteratively). Throws with the character offset on unbalanced input. */
export function parseSExpr(text: string): SExpr[] {
  if (text.length > MAX_KICAD_TEXT) throw new Error(`The file is ${text.length} characters long, more than this reader accepts (${MAX_KICAD_TEXT}).`);
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '(') {
      const list: SExpr[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      if (stack.length > MAX_SEXPR_DEPTH + 1) throw new Error(`The file nests more than ${MAX_SEXPR_DEPTH} levels deep at character ${i}: it is not a KiCad board.`);
      i++;
    } else if (ch === ')') {
      if (stack.length === 1) throw new Error(`Unexpected ")" at character ${i}.`);
      stack.pop();
      i++;
    } else if (ch === '"') {
      let s = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const next = text[i + 1]!;
          s += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else s += text[i++];
      }
      if (i >= n) throw new Error('A quoted string is not closed.');
      i++;
      stack[stack.length - 1]!.push(s);
    } else if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i++;
    } else {
      let j = i;
      while (j < n && !' \n\r\t()"'.includes(text[j]!)) j++;
      stack[stack.length - 1]!.push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error('The file ends inside an open "(": it is truncated or not a KiCad file.');
  return root;
}

const isList = (e: SExpr | undefined): e is SExpr[] => Array.isArray(e);
const head = (e: SExpr): string | undefined => (isList(e) && typeof e[0] === 'string' ? e[0] : undefined);
/** Child lists of `list` whose first atom is `name`. */
const children = (list: SExpr[], name: string): SExpr[][] => list.filter((e): e is SExpr[] => head(e) === name);
const child = (list: SExpr[], name: string): SExpr[] | undefined => children(list, name)[0];
const atom = (list: SExpr[] | undefined, i: number): string | undefined => {
  const v = list?.[i];
  return typeof v === 'string' ? v : undefined;
};
const num = (list: SExpr[] | undefined, i: number): number | undefined => {
  const s = atom(list, i);
  if (s === undefined) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};
/** (name x y) as a point. */
const point = (list: SExpr[], name: string): [number, number] | undefined => {
  const c = child(list, name);
  const x = num(c, 1);
  const y = num(c, 2);
  return x !== undefined && y !== undefined ? [x, y] : undefined;
};

// ---------------------------------------------------------------- geometry helpers

type P2 = [number, number];

/** A footprint's placement: board position (mm, KiCad frame) and rotation (degrees, CCW on screen). */
interface Placement {
  x: number;
  y: number;
  rot_deg: number;
}

/** Footprint-local point to KiCad board coordinates (see the header for the sign convention). */
function toBoard(fp: Placement, u: number, v: number): P2 {
  const a = (fp.rot_deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [fp.x + u * c + v * s, fp.y - u * s + v * c];
}

/** Points along an arc given by start, a point on it and end (KiCad 6+), for its bounding box. */
function arcThrough(a: P2, m: P2, b: P2): P2[] {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return [a, m, b]; // collinear: a straight line
  const sq = (p: P2) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy);
  const ang = (p: P2) => Math.atan2(p[1] - cy, p[0] - cx);
  const t0 = ang(a);
  // Sweep from a to b the way that passes through m.
  const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(ang(b) - t0);
  if (norm(ang(m) - t0) > sweep) sweep -= 2 * Math.PI;
  return arcPoints(cx, cy, r, t0, sweep);
}

function arcPoints(cx: number, cy: number, r: number, t0: number, sweep: number): P2[] {
  const out: P2[] = [];
  const steps = 64;
  for (let k = 0; k <= steps; k++) {
    const t = t0 + (sweep * k) / steps;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/** One Edge.Cuts item as points on it (board frame) and whether it is a straight segment or box. */
interface OutlineItem {
  kind: string;
  points: P2[];
  straight: boolean;
}

/** Outline items of one graphics list (`gr_*` on the board or `fp_*` in a footprint). */
function outlineItem(e: SExpr[], place: (u: number, v: number) => P2): OutlineItem | undefined {
  const kind = head(e)!.slice(3);
  const layer = atom(child(e, 'layer'), 1);
  if (layer !== 'Edge.Cuts') return undefined;
  const p = (name: string) => {
    const q = point(e, name);
    return q ? place(q[0], q[1]) : undefined;
  };
  switch (kind) {
    case 'line': {
      const a = p('start');
      const b = p('end');
      return a && b ? { kind, points: [a, b], straight: true } : undefined;
    }
    case 'rect': {
      const a = point(e, 'start');
      const b = point(e, 'end');
      if (!a || !b) return undefined;
      const corners: P2[] = [place(a[0], a[1]), place(b[0], a[1]), place(b[0], b[1]), place(a[0], b[1])];
      return { kind, points: corners, straight: true };
    }
    case 'circle': {
      const c = p('center');
      const end = p('end');
      if (!c || !end) return undefined;
      const r = Math.hypot(end[0] - c[0], end[1] - c[1]);
      return { kind, points: arcPoints(c[0], c[1], r, 0, 2 * Math.PI), straight: false };
    }
    case 'arc': {
      const a = p('start');
      const m = p('mid');
      const b = p('end');
      if (a && m && b) return { kind, points: arcThrough(a, m, b), straight: false };
      // KiCad 5: (start centre) (end start point) (angle sweep, degrees, clockwise on screen = CCW in math with y down).
      const angle = num(child(e, 'angle'), 1);
      if (a && b && angle !== undefined) {
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const t0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
        return { kind, points: arcPoints(a[0], a[1], r, t0, (angle * Math.PI) / 180), straight: false };
      }
      return undefined;
    }
    case 'poly': {
      const pts = child(e, 'pts');
      const points = pts ? children(pts, 'xy').map((xy) => place(num(xy, 1) ?? 0, num(xy, 2) ?? 0)) : [];
      return points.length > 0 ? { kind, points, straight: false } : undefined;
    }
    case 'curve': {
      // A Bezier lies inside the hull of its control points: a safe box.
      const pts = child(e, 'pts');
      const points = pts ? children(pts, 'xy').map((xy) => place(num(xy, 1) ?? 0, num(xy, 2) ?? 0)) : [];
      return points.length > 0 ? { kind, points, straight: false } : undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- connector families

interface Family {
  connector: string;
  ways?: number;
  interfaces: Interface[];
  /** Mouth height above the board (horizontal: housing height) and total height, mm. Rough. */
  height_mm: number;
  /** A family that is normally mounted on a board edge with the opening outward. */
  edge: boolean;
}

const JST_HEIGHT_MM: Record<string, { vertical: number; horizontal: number }> = {
  SH: { vertical: 4.25, horizontal: 2.95 },
  GH: { vertical: 4.25, horizontal: 4.25 },
  PH: { vertical: 6.0, horizontal: 4.8 },
  XH: { vertical: 7.0, horizontal: 5.75 },
  ZH: { vertical: 5.5, horizontal: 4.0 },
  EH: { vertical: 6.0, horizontal: 4.8 },
};

/**
 * Connector family from a footprint name (the part after `Library:`), or
 * undefined when the name is not recognised. Heights are typical values for
 * the envelope and port height, not datasheet figures.
 */
export function guessFamily(footprint: string): Family | undefined {
  const name = footprint.includes(':') ? footprint.slice(footprint.indexOf(':') + 1) : footprint;
  const vertical = /Vertical/i.test(name);
  const oneRow = /_1x0*(\d+)/.exec(name);
  const ways1 = oneRow ? Number(oneRow[1]) : undefined;
  let m: RegExpExecArray | null;

  if ((m = /^Pin(Header|Socket)_(\d+)x0*(\d+)_P2\.54mm/i.exec(name))) {
    const rows = Number(m[2]);
    const perRow = Number(m[3]);
    const base = m[1]!.toLowerCase() === 'header' ? 'pin-header-2.54' : 'pin-socket-2.54';
    // A vertical header's mouth is the top of its plastic; the pins stand 6 mm above that.
    return { connector: rows === 2 ? `${base}-2row` : base, ways: rows * perRow, interfaces: ['other'], height_mm: m[1]!.toLowerCase() === 'header' ? 2.5 : 8.5, edge: false };
  }
  if ((m = /JST_(SH|GH|PH|XH|ZH|EH)_/i.exec(name))) {
    const series = m[1]!.toUpperCase();
    const h = JST_HEIGHT_MM[series]!;
    return { connector: `jst-${series.toLowerCase()}`, ways: ways1, interfaces: ['other'], height_mm: vertical ? h.vertical : h.horizontal, edge: !vertical };
  }
  if (/USB_C_(Receptacle|Plug)/i.test(name)) return { connector: 'usb-c', interfaces: ['usb2'], height_mm: 3.2, edge: true };
  if (/USB_Micro-B/i.test(name)) return { connector: 'usb-micro-b', interfaces: ['usb2'], height_mm: 2.8, edge: true };
  if (/USB_A/i.test(name)) return { connector: 'usb-a', interfaces: ['usb2'], height_mm: vertical ? 14 : 7, edge: !vertical };
  if (/RJ45/i.test(name)) return { connector: 'rj45', interfaces: ['ethernet'], height_mm: 13.5, edge: true };
  if ((m = /TerminalBlock.*_P(5\.08|5\.00|3\.81|3\.50|2\.54)mm/i.exec(name))) {
    return { connector: `screw-terminal-${m[1]!.replace(/0$/, '').replace(/\.$/, '.0')}`, ways: ways1, interfaces: ['other'], height_mm: 10, edge: !vertical };
  }
  if (/BarrelJack/i.test(name)) return { connector: 'barrel-jack-5.5x2.1', interfaces: ['power'], height_mm: 11, edge: true };
  if ((m = /Hirose_FH12-0*(\d+)S-0\.5SH/i.exec(name))) return { connector: 'ffc-0.5', ways: Number(m[1]), interfaces: ['other'], height_mm: 2, edge: true };
  if (/FFC|FPC|Hirose_FH/i.test(name)) {
    const pitch = /_P(0\.5|1\.0)0?mm/i.exec(name)?.[1] ?? (/0\.5/.test(name) ? '0.5' : /1\.0/.test(name) ? '1.0' : undefined);
    if (pitch) {
      const ways = ways1 ?? (/[-_]0*(\d+)(S|P|Pin)\b/i.exec(name) ? Number(/[-_]0*(\d+)(S|P|Pin)\b/i.exec(name)![1]) : undefined);
      return { connector: `ffc-${pitch}`, ways, interfaces: ['other'], height_mm: 2, edge: true };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- footprints

interface Pad {
  /** Board frame, mm. */
  at: P2;
  type: string;
  drill_mm?: number;
}

interface Footprint {
  lib: string;
  ref: string;
  value?: string;
  place: Placement;
  back: boolean;
  pads: Pad[];
}

function readFootprint(e: SExpr[]): Footprint {
  const lib = atom(e, 1) ?? '';
  const at = child(e, 'at');
  const place: Placement = { x: num(at, 1) ?? 0, y: num(at, 2) ?? 0, rot_deg: num(at, 3) ?? 0 };
  const layer = atom(child(e, 'layer'), 1) ?? 'F.Cu';
  // KiCad 8+: (property "Reference" "J1"); KiCad 5 to 7: (fp_text reference "J1").
  const prop = (key: string) => children(e, 'property').find((p) => atom(p, 1) === key);
  const text = (key: string) => children(e, 'fp_text').find((p) => atom(p, 1) === key);
  const ref = atom(prop('Reference'), 2) ?? atom(text('reference'), 2) ?? '';
  const value = atom(prop('Value'), 2) ?? atom(text('value'), 2);
  const pads = children(e, 'pad').map((pad): Pad => {
    const pat = child(pad, 'at');
    const drill = child(pad, 'drill');
    // (drill 3.2) or (drill oval 1.2 2.0): the first number is the (smaller) size across.
    const drillNum = drill ? (num(drill, 1) ?? num(drill, 2)) : undefined;
    return { at: toBoard(place, num(pat, 1) ?? 0, num(pat, 2) ?? 0), type: atom(pad, 2) ?? '', drill_mm: drillNum };
  });
  return { lib, ref, value, place, back: layer.startsWith('B.'), pads };
}

// ---------------------------------------------------------------- the part

export interface ParseKicadOptions {
  /** Part name. Default: the title block's title, else the file's own name for the board. */
  name?: string;
  /** Checked against when given: unknown connector ids give a warning (and are kept). */
  connectors?: ConnectorLibrary;
}

/** How far from a board edge a footprint may sit and still count as on the edge, mm. */
const EDGE_DISTANCE_MM = 3;
/** Pins of through-hole parts stick out below the board by about this much, mm. */
const PIN_PROTRUSION_MM = 2;
/** Height of a back-side component that is not a known connector, mm. A guess. */
const BACK_PART_HEIGHT_MM = 2;
/** Room above the board when nothing says more, mm. A guess. */
const DEFAULT_TOP_HEIGHT_MM = 8;

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0; // + 0 turns -0 into 0
const r7 = (v: number): number => Math.round(v * 1e7) / 1e7 + 0;

/** Quaternion [x, y, z, w] of the frame with axes X, Y (Z = X x Y), all in the part frame. */
function frameQuat(X: Vector3, Y: Vector3): [number, number, number, number] {
  const Z = new Vector3().crossVectors(X, Y);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(X, Y, Z));
  return [r7(q.x), r7(q.y), r7(q.z), r7(q.w)];
}

/** 32-bit FNV-1a of the text, 8 hex digits: a stable id suffix without async hashing. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A reference made fit for `IdSchema`, unique among `taken`. */
function portId(ref: string, taken: Set<string>): string {
  let base = ref.replace(/[^A-Za-z0-9_.:-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '') || 'port';
  base = base.slice(0, 100);
  let id = base;
  for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
  taken.add(id);
  return id;
}

/**
 * Read a `.kicad_pcb` file into a part. Throws only when the text is not a
 * KiCad board or has no outline on Edge.Cuts; everything guessed is said in
 * `warnings`.
 */
export function parseKicadPcb(text: string, opts: ParseKicadOptions = {}): { part: Part; warnings: string[] } {
  const warnings: string[] = [];
  const top = parseSExpr(text).find((e) => head(e) === 'kicad_pcb');
  if (!isList(top)) throw new Error('This is not a KiCad board file: it has no (kicad_pcb ...) at the top.');

  // ---- outline
  const items: OutlineItem[] = [];
  for (const e of top) {
    const h = head(e);
    if (h && h.startsWith('gr_') && isList(e)) {
      const item = outlineItem(e, (u, v) => [u, v]);
      if (item) items.push(item);
    }
  }
  const footprints = [...children(top, 'footprint'), ...children(top, 'module')];
  for (const e of footprints) {
    const fp = readFootprint(e);
    for (const g of e) {
      const h = head(g);
      if (h && h.startsWith('fp_') && isList(g)) {
        const item = outlineItem(g, (u, v) => toBoard(fp.place, u, v));
        if (item) items.push(item);
      }
    }
  }
  if (items.length === 0) throw new Error('The board has no outline: nothing is drawn on layer Edge.Cuts.');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    for (const [x, y] of it.points) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sx = maxX - minX;
  const sy = maxY - minY;
  // KiCad board (mm, y down) -> part frame x, y (mm, y up, centred).
  const toPart = (p: P2): P2 => [p[0] - cx, -(p[1] - cy)];

  // A plain rectangle: every item that reaches the box edge is a straight segment lying on it.
  // Items wholly inside are cut-outs and do not change the envelope.
  const tol = 0.01;
  const onBox = (p: P2) => Math.abs(p[0] - minX) < tol || Math.abs(p[0] - maxX) < tol || Math.abs(p[1] - minY) < tol || Math.abs(p[1] - maxY) < tol;
  const inside = (it: OutlineItem) => it.points.every((p) => p[0] > minX + tol && p[0] < maxX - tol && p[1] > minY + tol && p[1] < maxY - tol);
  const rectangular = items.filter((it) => !inside(it)).every((it) => {
    if (!it.straight) return false;
    if (it.kind === 'rect') return it.points.every(onBox);
    const [a, b] = it.points as [P2, P2];
    const sameX = Math.abs(a[0] - b[0]) < tol && (Math.abs(a[0] - minX) < tol || Math.abs(a[0] - maxX) < tol);
    const sameY = Math.abs(a[1] - b[1]) < tol && (Math.abs(a[1] - minY) < tol || Math.abs(a[1] - maxY) < tol);
    return sameX || sameY;
  });
  if (!rectangular) warnings.push(`The board outline is not a plain rectangle; the envelope is its bounding box, ${r3(sx)} x ${r3(sy)} mm.`);

  // ---- thickness
  let thickness_mm = num(child(child(top, 'general') ?? [], 'thickness'), 1);
  if (thickness_mm === undefined || !(thickness_mm > 0)) {
    thickness_mm = 1.6;
    warnings.push('The file does not give the board thickness; assuming 1.6 mm.');
  }

  // ---- footprints: holes, ports, what hangs below
  const fps = footprints.map(readFootprint);
  const mounting_holes: Part['mounting_holes'] = [];
  const ports: Port[] = [];
  const taken = new Set<string>();
  let throughHole = false;
  let backRoom_mm = 0;
  let topHeight_mm = DEFAULT_TOP_HEIGHT_MM;
  let topFromConnectors = false;
  const backRefs: string[] = [];
  const pendingPorts: { fp: Footprint; family: Family | undefined }[] = [];

  for (const fp of fps) {
    const libName = fp.lib.includes(':') ? fp.lib.slice(fp.lib.indexOf(':') + 1) : fp.lib;
    if (/MountingHole/i.test(fp.lib)) {
      const pad = fp.pads.find((p) => p.drill_mm !== undefined) ?? fp.pads[0];
      const at = toPart(pad ? pad.at : [fp.place.x, fp.place.y]);
      const fromName = /MountingHole_(\d+(?:\.\d+)?)mm/i.exec(libName);
      const d_mm = pad?.drill_mm ?? (fromName ? Number(fromName[1]) : undefined);
      if (d_mm === undefined || !(d_mm > 0)) {
        warnings.push(`Mounting hole ${fp.ref || libName}: no drill size found; assuming 3.2 mm.`);
      }
      mounting_holes.push({ p_mm: [r3(at[0]), r3(at[1])], d_mm: d_mm && d_mm > 0 ? d_mm : 3.2 });
      continue;
    }
    if (fp.pads.some((p) => p.type === 'thru_hole')) throughHole = true;
    const nickname = fp.lib.includes(':') ? fp.lib.slice(0, fp.lib.indexOf(':')) : '';
    const isConnector = nickname.startsWith('Connector') || /^(J|P|CN|USB|X)\d/i.test(fp.ref);
    const family = isConnector ? guessFamily(fp.lib) : undefined;
    if (fp.back) {
      backRefs.push(fp.ref || libName);
      backRoom_mm = Math.max(backRoom_mm, family ? family.height_mm + (family.connector.startsWith('pin-header') ? 6 : 0) : BACK_PART_HEIGHT_MM);
    }
    if (!isConnector) continue;
    if (!fp.back && family) {
      // A vertical header's pins stand about 6 mm above its plastic.
      const total = family.height_mm + (family.connector.startsWith('pin-header') ? 6 : 0);
      if (total > topHeight_mm) {
        topHeight_mm = total;
        topFromConnectors = true;
      }
    }
    pendingPorts.push({ fp, family });
  }

  const board_z_mm = Math.max(throughHole ? PIN_PROTRUSION_MM : 0, backRoom_mm);
  const boardTop_mm = board_z_mm + thickness_mm;
  const size_z_mm = boardTop_mm + topHeight_mm;
  if (backRefs.length > 0) {
    warnings.push(`On the back of the board (placed on the underside, ${r3(board_z_mm)} mm of room assumed below it): ${backRefs.join(', ')}.`);
  }
  warnings.push(
    `The envelope height of ${r3(size_z_mm)} mm is a guess: ${r3(board_z_mm)} mm below the board${throughHole ? ' for through-hole pins' : ''}, ${r3(thickness_mm)} mm of board and ${r3(topHeight_mm)} mm above it${topFromConnectors ? ' (from the tallest connector)' : ''}. Measure the real part and correct it.`,
  );

  for (const { fp, family } of pendingPorts) {
    const libName = fp.lib.includes(':') ? fp.lib.slice(fp.lib.indexOf(':') + 1) : fp.lib;
    const label = fp.ref || libName;
    const connector = family?.connector ?? 'other';
    if (!family) warnings.push(`${label}: footprint "${fp.lib}" is not a connector this importer knows; the port uses connector "other". Set the right connector by hand.`);
    else if (opts.connectors && !findConnector(opts.connectors, family.connector)) {
      warnings.push(`${label}: connector "${family.connector}" (from footprint "${libName}") is not in the connector library.`);
    }

    // Contact centre: the middle of the pads (the footprint origin is often pin 1), else the origin.
    const kicadCentre: P2 =
      fp.pads.length > 0
        ? [fp.pads.reduce((a, p) => a + p.at[0], 0) / fp.pads.length, fp.pads.reduce((a, p) => a + p.at[1], 0) / fp.pads.length]
        : [fp.place.x, fp.place.y];
    const [px, py] = toPart(kicadCentre);
    const up = fp.back ? -1 : 1;
    const height_mm = family?.height_mm ?? 3;

    // Distance to each edge of the box, part frame: +x, -x, +y, -y.
    const edges: { d: number; n: Vector3 }[] = [
      { d: sx / 2 - px, n: new Vector3(1, 0, 0) },
      { d: px + sx / 2, n: new Vector3(-1, 0, 0) },
      { d: sy / 2 - py, n: new Vector3(0, 1, 0) },
      { d: py + sy / 2, n: new Vector3(0, -1, 0) },
    ];
    const nearest = edges.reduce((a, b) => (b.d < a.d ? b : a));
    const vertical = /Vertical/i.test(libName);
    const horizontal = /Horizontal|Right_?Angle|_RA\b/i.test(libName) || (family?.edge ?? false);
    const atEdge = nearest.d <= EDGE_DISTANCE_MM;

    let pose: Port['pose'];
    let note: string | undefined;
    if (!vertical && (atEdge || (horizontal && !vertical))) {
      if (!atEdge) {
        warnings.push(`${label}: a horizontal connector ${r3(nearest.d)} mm from the nearest edge; its exit is taken to be across that edge.`);
      }
      // Exit outward across the nearest edge, mouth on the edge line, half the housing above (or below) the board.
      const X = nearest.n.clone();
      const Z = new Vector3(0, 0, up);
      const Y = new Vector3().crossVectors(Z, X);
      const p: [number, number] = [px, py];
      if (atEdge) {
        if (X.x !== 0) p[0] = (X.x * sx) / 2;
        else p[1] = (X.y * sy) / 2;
        note = 'mouth placed on the board edge';
      }
      const z = fp.back ? board_z_mm - height_mm / 2 : boardTop_mm + height_mm / 2;
      pose = { p_mm: [r3(p[0]), r3(p[1]), r3(z)], q: frameQuat(X, Y) };
    } else {
      // Exit straight up (down for the back side). +Y runs along the pin row: footprint-local
      // +v (pin 1 to pin 2 in KiCad headers) is board (sin a, cos a) in KiCad and (sin a, -cos a) here.
      const a = (fp.place.rot_deg * Math.PI) / 180;
      const X = new Vector3(0, 0, up);
      let Y = new Vector3(Math.sin(a), -Math.cos(a), 0);
      if (fp.back) Y = Y.negate(); // keeps the frame right-handed with X pointing down; Z stays across the rows
      const z = fp.back ? board_z_mm - height_mm : boardTop_mm + height_mm;
      pose = { p_mm: [r3(px), r3(py), r3(z)], q: frameQuat(X, Y) };
    }

    const port: Port = {
      id: portId(fp.ref || libName, taken),
      connector,
      pose,
      interfaces: family?.interfaces ?? ['other'],
      note: [`footprint ${fp.lib}`, fp.back ? 'on the back of the board' : undefined, note].filter(Boolean).join('; '),
    };
    if (fp.value) port.name = fp.value;
    if (family?.ways !== undefined) port.ways = family.ways;
    ports.push(port);
  }

  // ---- name and id
  const title = atom(child(child(top, 'title_block') ?? [], 'title'), 1);
  const name = opts.name?.trim() || title?.trim() || 'KiCad board';
  const part: Part = {
    id: `custom-${slugify(name)}-${fnv1a(text)}`,
    name,
    category: 'other',
    tags: ['kicad'],
    body: { size_mm: [r3(sx), r3(sy), r3(size_z_mm)], board: { z_mm: r3(board_z_mm), thickness_mm } },
    mounting_holes,
    ports,
    confidence: 'measured',
    custom: true,
  };
  return { part, warnings };
}
