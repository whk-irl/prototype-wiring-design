/**
 * Thumbnails of cable types, drawn from the type's own figures (no image
 * files): a short piece of the cable lying along +X, its cut end at +X facing
 * the thumbnail camera (which looks from +X, -Y, +Z).
 *
 *  - Round (wire, multi-core, twisted pair, coax, USB, Ethernet, harness,
 *    jumper): the jacket at its real outer diameter; in the cut face the
 *    conductors stand out a little. One conductor for a single wire, two side
 *    by side for a twisted pair, a ring of them for multi-core. Their size is
 *    the gauge's (`awgDiameterMm`) when the gauge is known; their POSITIONS
 *    are illustrative only, not data.
 *  - Ribbon: round insulated wires side by side at the pitch.
 *  - Flat flex (FFC, FPC): a thin strip at its real width and thickness with
 *    a bare contact finger per way at the pitch over the last stretch.
 *
 * Proportions are the type's real ones. Two things are drawn larger than
 * real so they can be seen at 56 px: copper standing proud of a cut face
 * (a length of a third of the conductor size), and the contact fingers of a
 * flat flex, which are drawn on top of the strip at a quarter of its
 * thickness but never thinner than 0.02 mm. The piece's length is chosen per
 * shape (a few diameters, or about the width of a flat cable) so the cut end
 * fills the picture; it says nothing about any real length.
 */
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import { awgDiameterMm, type CableType } from '@core';

/** Bump when the drawing changes, to retire cached images. */
export const CABLE_THUMB_VERSION = 3;

const COPPER = 0xc8834a;
const FAMILY_COLOR: Partial<Record<CableType['family'], number>> = {
  hookup_wire: 0xc0392b,
  jumper: 0xd35400,
  ribbon: 0x9aa3ad,
  ffc: 0xd9a441,
  multicore: 0x3d4450,
  twisted_pair: 0x3d4450,
  coax: 0x2d2f33,
  usb: 0x2d2f33,
  ethernet: 0x2f6fb0,
  harness: 0x3d4450,
};
const CORE_COLORS = [0xc0392b, 0x2c3e50, 0x27ae60, 0xf1c40f, 0x2980b9, 0xecf0f1, 0x8e44ad, 0xe67e22];

/** FNV-1a, 8 hex digits. */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Cache key: only what the picture shows (family, section, conductors, pitch, gauge). */
export function cableThumbKey(type: CableType): string {
  return `cable:${CABLE_THUMB_VERSION}:${fnv(JSON.stringify([type.family, type.section, type.conductors, type.pitch_mm ?? null, type.awg ?? null]))}`;
}

const mat = (color: number, rough = 0.6) => new MeshStandardMaterial({ color, roughness: rough, metalness: color === COPPER ? 0.5 : 0.05 });

/** A cylinder along +X from x0 to x1. */
function rod(radius: number, x0: number, x1: number, color: number, y = 0, z = 0): Mesh {
  const g = new CylinderGeometry(radius, radius, x1 - x0, 24);
  g.rotateZ(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, z);
  return new Mesh(g, mat(color));
}

function box(x0: number, x1: number, w: number, t: number, color: number, y = 0, z = 0): Mesh {
  const g = new BoxGeometry(x1 - x0, w, t);
  g.translate((x0 + x1) / 2, y, z);
  return new Mesh(g, mat(color, 0.5));
}

/** The conductor diameter drawn in a round cable's cut face. */
function conductorSize(type: CableType, od: number, n: number): number {
  if (type.awg !== undefined) return Math.min(awgDiameterMm(type.awg), od * 0.8);
  if (n <= 1) return od * 0.45;
  return (od * 0.8) / (n <= 2 ? 2.2 : 1 + 1 / Math.sin(Math.PI / Math.min(n, 12)));
}

/**
 * The object the thumbnail camera sees: the piece turned 50 degrees about
 * +Z so that its cut end faces the camera (which looks from +X, -Y, +Z).
 */
export function cableThumbScene(type: CableType): Object3D {
  const g = new Group();
  const piece = cableThumbObject(type);
  piece.rotation.z = (-50 * Math.PI) / 180;
  g.add(piece);
  return g;
}

/** The piece of cable for a type's thumbnail, in mm, lying along X with its cut end at x = 0. */
export function cableThumbObject(type: CableType): Object3D {
  const g = new Group();
  const color = FAMILY_COLOR[type.family] ?? 0x5b6470;
  if (type.section.shape === 'round') {
    const od = type.section.od_mm;
    const len = od * 2.5;
    const n = type.conductors;
    const d = conductorSize(type, od, n);
    const proud = d / 3;
    g.add(rod(od / 2, -len, 0, color));
    // The cut face: the insulation filling the jacket, light so the cores stand out on it.
    if (n > 1) g.add(rod(od / 2 - Math.min(0.2 * od, 0.3), -0.01, od * 0.02, 0xd9d9d9));
    if (n <= 1) {
      g.add(rod(od / 2 - 0.02, -0.01, od * 0.02, 0xd9d9d9));
      g.add(rod(d / 2, -0.01, proud + od * 0.02, COPPER));
    } else if (type.family === 'twisted_pair' || n === 2) {
      // Two insulated cores side by side (their lay is not shown).
      const core = Math.min(od * 0.42, d * 1.6);
      for (const [i, y] of [-core / 2, core / 2].entries()) {
        g.add(rod(core / 2, -0.01, proud, CORE_COLORS[i]!, y));
        g.add(rod(d / 2, proud - 0.01, proud * 2, COPPER, y));
      }
    } else {
      // A ring of insulated cores (up to 12 drawn); positions illustrative.
      const shown = Math.min(n, 12);
      const ring = od / 2 - d * 0.9;
      for (let i = 0; i < shown; i++) {
        const a = (2 * Math.PI * i) / shown;
        const y = Math.cos(a) * Math.max(ring, d);
        const z = Math.sin(a) * Math.max(ring, d);
        g.add(rod(d * 0.75, -0.01, proud, CORE_COLORS[i % CORE_COLORS.length]!, y, z));
        g.add(rod(d / 2, proud - 0.01, proud * 2, COPPER, y, z));
      }
    }
    return g;
  }
  const { width_mm: w, thickness_mm: t } = type.section;
  const ways = Math.max(1, type.conductors);
  const pitch = type.pitch_mm ?? w / ways;
  const len = Math.max(w * 0.9, t * 12, 4);
  if (type.family === 'ribbon') {
    // Insulated round wires side by side at the pitch, conductors in the cut face.
    const r = Math.min(pitch, t) / 2;
    const d = type.awg !== undefined ? Math.min(awgDiameterMm(type.awg), r * 1.6) : r;
    for (let i = 0; i < ways; i++) {
      const y = (i - (ways - 1) / 2) * pitch;
      g.add(rod(r, -len, 0, i === 0 ? 0xc0392b : color, y));
      g.add(rod(d / 2, -0.01, d / 3, COPPER, y));
    }
    return g;
  }
  // Flat flex: the strip, and a bare finger per way over the last stretch.
  const finger = Math.min(len * 0.3, Math.max(1, pitch * 4));
  g.add(box(-len, 0, w, t, color));
  const ft = Math.max(t / 4, 0.02);
  for (let i = 0; i < ways; i++) {
    const y = (i - (ways - 1) / 2) * pitch;
    g.add(box(-finger, 0, pitch / 2, ft, COPPER, y, t / 2 + ft / 2));
  }
  return g;
}
