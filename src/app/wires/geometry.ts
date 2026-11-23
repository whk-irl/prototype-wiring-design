/**
 * Wire geometry at true size: the centre line with its corners rounded as far
 * as the route allows (up to the cable's bend radius, so a legal route looks
 * smooth and an illegal one kinks), and tube / ribbon meshes along it. Pure three.js maths and geometry.
 */
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import type { Vec3 } from '@core';

/** A point of a drawn centre line with the surface normal it sits on (zero when free). */
export interface LinePoint {
  p: Vector3;
  n: Vector3;
}

/**
 * Round each interior corner with radius min(the largest the corner allows
 * using half of each leg, `bendRadius`). Returns a dense polyline.
 */
export function roundedLine(points: readonly LinePoint[], bendRadius: number, arcStepDeg = 10): LinePoint[] {
  if (points.length < 3) return points.map((x) => ({ p: x.p.clone(), n: x.n.clone() }));
  const out: LinePoint[] = [{ p: points[0]!.p.clone(), n: points[0]!.n.clone() }];
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[i - 1]!;
    const q = points[i]!;
    const c = points[i + 1]!;
    const u1 = q.p.clone().sub(a.p);
    const u2 = c.p.clone().sub(q.p);
    const l1 = u1.length();
    const l2 = u2.length();
    if (l1 < 1e-9 || l2 < 1e-9) {
      out.push({ p: q.p.clone(), n: q.n.clone() });
      continue;
    }
    u1.divideScalar(l1);
    u2.divideScalar(l2);
    const turn = Math.acos(Math.min(1, Math.max(-1, u1.dot(u2))));
    if (turn < 1e-6 || Math.PI - turn < 1e-6) {
      out.push({ p: q.p.clone(), n: q.n.clone() });
      continue;
    }
    const allowed = Math.min(l1, l2) / 2 / Math.tan(turn / 2);
    const R = Math.min(allowed, bendRadius);
    const t = R * Math.tan(turn / 2);
    const start = q.p.clone().addScaledVector(u1, -t);
    const bis = u2.clone().sub(u1).normalize();
    const centre = q.p.clone().addScaledVector(bis, R / Math.cos(turn / 2));
    const steps = Math.max(2, Math.ceil((turn * 180) / Math.PI / arcStepDeg));
    const r0 = start.clone().sub(centre);
    const axis = new Vector3().crossVectors(u1, u2).normalize();
    for (let k = 0; k <= steps; k++) {
      const p = r0.clone().applyAxisAngle(axis, (turn * k) / steps).add(centre);
      out.push({ p, n: q.n.clone() });
    }
  }
  const last = points[points.length - 1]!;
  out.push({ p: last.p.clone(), n: last.n.clone() });
  return out;
}

export function polylineLen(points: readonly Vector3[]): number {
  let t = 0;
  for (let i = 1; i < points.length; i++) t += points[i]!.distanceTo(points[i - 1]!);
  return t;
}

/** Parallel-transport frames along a polyline. */
function frames(points: readonly Vector3[], firstUp?: Vector3): Array<{ t: Vector3; u: Vector3; v: Vector3 }> {
  const out: Array<{ t: Vector3; u: Vector3; v: Vector3 }> = [];
  let prevU: Vector3 | null = null;
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)]!;
    const b = points[Math.min(points.length - 1, i + 1)]!;
    const t = b.clone().sub(a);
    if (t.lengthSq() < 1e-18) t.set(0, 0, 1);
    t.normalize();
    let u: Vector3;
    if (!prevU) {
      u = (firstUp ? firstUp.clone() : Math.abs(t.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)).addScaledVector(t, -(firstUp ?? (Math.abs(t.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0))).dot(t));
      if (u.lengthSq() < 1e-12) u = new Vector3(1, 0, 0).addScaledVector(t, -t.x);
    } else u = prevU.clone().addScaledVector(t, -prevU.dot(t));
    u.normalize();
    const v = new Vector3().crossVectors(t, u);
    out.push({ t, u, v });
    prevU = u;
  }
  return out;
}

/**
 * Tube(s) along a centre line. `offsets` places several wires in the cross
 * section (bundle); `twistPerMm` turns them about the centre line (radians per
 * mm) so a twisted bundle reads differently from a parallel one.
 */
export function tubeGeometry(points: readonly Vector3[], radius: number, offsets: ReadonlyArray<[number, number]> = [[0, 0]], twistPerMm = 0, radial = 10): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  if (points.length < 2) return new BufferGeometry();
  const f = frames(points);
  const along: number[] = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1]! + points[i]!.distanceTo(points[i - 1]!));
  for (const [ox, oy] of offsets) {
    const base = pos.length / 3;
    for (let i = 0; i < points.length; i++) {
      const { u, v } = f[i]!;
      const ang = along[i]! * twistPerMm;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const cx = ox * ca - oy * sa;
      const cy = ox * sa + oy * ca;
      const centre = points[i]!.clone().addScaledVector(u, cx).addScaledVector(v, cy);
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * Math.PI * 2;
        const n = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
        const p = centre.clone().addScaledVector(n, radius);
        pos.push(p.x, p.y, p.z);
        nor.push(n.x, n.y, n.z);
      }
    }
    for (let i = 0; i + 1 < points.length; i++)
      for (let j = 0; j < radial; j++) {
        const a = base + i * radial + j;
        const b = base + i * radial + ((j + 1) % radial);
        const c = a + radial;
        const d = b + radial;
        idx.push(a, b, d, a, d, c);
      }
    // Closed ends: a flat cap on each, facing out along the line.
    const last = points.length - 1;
    for (const [i, sign] of [
      [0, -1],
      [last, 1],
    ] as const) {
      const t = points[Math.min(last, i + 1)]!.clone().sub(points[Math.max(0, i - 1)]!).normalize().multiplyScalar(sign);
      const ringStart = base + i * radial;
      const capBase = pos.length / 3;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let j = 0; j < radial; j++) {
        const k = 3 * (ringStart + j);
        pos.push(pos[k]!, pos[k + 1]!, pos[k + 2]!);
        nor.push(t.x, t.y, t.z);
        cx += pos[k]!;
        cy += pos[k + 1]!;
        cz += pos[k + 2]!;
      }
      pos.push(cx / radial, cy / radial, cz / radial);
      nor.push(t.x, t.y, t.z);
      const centre = capBase + radial;
      for (let j = 0; j < radial; j++) {
        const a = capBase + j;
        const b = capBase + ((j + 1) % radial);
        if (sign > 0) idx.push(centre, a, b);
        else idx.push(centre, b, a);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/**
 * A flat ribbon of `width` x `height` along a centre line, lying on the
 * surface given by each point's normal (twisting smoothly between points
 * whose surfaces differ). Points without a normal use the previous one.
 */
export function ribbonGeometry(line: readonly LinePoint[], width: number, height: number): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  if (line.length < 2) return new BufferGeometry();
  const f = frames(line.map((x) => x.p));
  let up = new Vector3();
  const corners: Array<[number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const ringNormals: Array<'down' | 'side+' | 'up' | 'side-'> = ['down', 'side+', 'up', 'side-'];
  for (let i = 0; i < line.length; i++) {
    const t = f[i]!.t;
    const n = line[i]!.n;
    let want = n.lengthSq() > 0.5 ? n.clone() : up.lengthSq() > 0 ? up.clone() : f[i]!.u.clone();
    want.addScaledVector(t, -want.dot(t));
    if (want.lengthSq() < 1e-12) want = f[i]!.u.clone();
    up = want.normalize();
    const side = new Vector3().crossVectors(t, up);
    // 4 faces, each with its own vertices for flat shading: down, side+, up, side-
    for (let face = 0; face < 4; face++) {
      const [ax, ay] = corners[face]!;
      const [bx, by] = corners[(face + 1) % 4]!;
      const fn = ringNormals[face]!;
      const nn = fn === 'down' ? up.clone().negate() : fn === 'up' ? up.clone() : fn === 'side+' ? side.clone() : side.clone().negate();
      for (const [sx, sy] of [
        [ax, ay],
        [bx, by],
      ] as const) {
        const p = line[i]!.p.clone().addScaledVector(side, (sx * width) / 2).addScaledVector(up, (sy * height) / 2);
        pos.push(p.x, p.y, p.z);
        nor.push(nn.x, nn.y, nn.z);
      }
    }
  }
  const per = 8;
  for (let i = 0; i + 1 < line.length; i++)
    for (let face = 0; face < 4; face++) {
      const a = i * per + face * 2;
      const b = a + 1;
      const c = a + per;
      const d = b + per;
      idx.push(a, b, d, a, d, c);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** Centres of `count` wires of diameter d in a bundle of diameter D (display only; the envelope gives the size). */
export function bundleOffsets(count: number, d: number, D: number): Array<[number, number]> {
  if (count <= 1) return [[0, 0]];
  const out: Array<[number, number]> = [];
  if (count <= 6) {
    const R = (D - d) / 2;
    for (let i = 0; i < count; i++) out.push([R * Math.cos((2 * Math.PI * i) / count), R * Math.sin((2 * Math.PI * i) / count)]);
    return out;
  }
  out.push([0, 0]);
  let ring = 1;
  while (out.length < count) {
    const R = ring * d;
    const k = Math.max(6, Math.floor((2 * Math.PI * R) / d));
    for (let i = 0; i < k && out.length < count; i++) out.push([R * Math.cos((2 * Math.PI * i) / k), R * Math.sin((2 * Math.PI * i) / k)]);
    ring++;
  }
  return out;
}

export const toVec3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];
