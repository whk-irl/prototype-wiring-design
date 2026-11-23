/**
 * Editing the ports of a user's own part. Pure: each function returns a new
 * part (or port). Port frame (see `PortSchema`): origin at the mouth of the
 * connector, +X the way the cable leaves, +Y along the row of contacts, +Z
 * the connector's height.
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import { findConnector, type Connector, type ConnectorLibrary, type Part, type Port, type Vec3 } from '@core';

export type ExitDir = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

const H = Math.SQRT1_2;
/**
 * The port rotation for each exit direction, relative to the part (x, y, z, w).
 * Sideways exits keep the port's +Z along the part's +Z; an exit up (+Z) or
 * down (-Z) turns about the part's Y axis, keeping +Y along the part's +Y.
 */
export const EXIT_QUATS: Record<ExitDir, [number, number, number, number]> = {
  '+x': [0, 0, 0, 1],
  '-x': [0, 0, 1, 0],
  '+y': [0, 0, H, H],
  '-y': [0, 0, -H, H],
  '+z': [0, -H, 0, H],
  '-z': [0, H, 0, H],
};

const r7 = (v: number) => Math.round(v * 1e7) / 1e7 + 0;
const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** The rotation of a port whose cable leaves along `normal` (part frame): +Z kept as near the part's +Z as it can be. */
export function quatForExit(normal: Vec3): [number, number, number, number] {
  const x = new Vector3(...normal).normalize();
  const up = Math.abs(x.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  // y = up x x keeps z = x x y close to `up`.
  const y = new Vector3().crossVectors(up, x).normalize();
  const z = new Vector3().crossVectors(x, y);
  const q = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
  return [r7(q.x), r7(q.y), r7(q.z), r7(q.w)];
}

/** The sizes a connector family comes in that split evenly over its rows (what `portProblem` accepts). */
export function waysChoices(conn: Connector): number[] {
  const out: number[] = [];
  for (let w = Math.ceil(conn.ways.min / conn.rows) * conn.rows; w <= conn.ways.max && out.length < 80; w += conn.rows) out.push(w);
  return out;
}

/** The ways to write on a port: the smallest valid size when the family comes in several, else none. */
function defaultWays(conn: Connector | undefined): number | undefined {
  return conn && conn.ways.min !== conn.ways.max ? (waysChoices(conn)[0] ?? conn.ways.min) : undefined;
}

function nextPortId(part: Part): string {
  const taken = new Set(part.ports.map((p) => p.id));
  for (let n = 1; ; n++) if (!taken.has(`port${n}`)) return `port${n}`;
}

/**
 * A new port at `point` (part frame), the cable leaving along `normal` (the
 * surface normal where the user clicked). Connector: `connector` or the
 * first in the library, at its smallest size.
 */
export function addPortAt(part: Part, point: Vec3, normal: Vec3, connectors: ConnectorLibrary | null, connector?: string): { part: Part; port: Port } {
  const id = nextPortId(part);
  const conn = connectors ? (connector ? findConnector(connectors, connector) : connectors.connectors[0]) : undefined;
  const port: Port = {
    id,
    name: `Port ${part.ports.length + 1}`,
    connector: conn?.id ?? connector ?? 'unknown',
    ...(defaultWays(conn) !== undefined ? { ways: defaultWays(conn) } : {}),
    pose: { p_mm: [r3(point[0]), r3(point[1]), r3(point[2])], q: quatForExit(normal) },
    interfaces: ['other'],
  };
  return { part: { ...part, ports: [...part.ports, port] }, port };
}

export function updatePort(part: Part, id: string, patch: Partial<Omit<Port, 'id'>>): Part {
  return {
    ...part,
    ports: part.ports.map((p) => {
      if (p.id !== id) return p;
      const next = { ...p, ...patch };
      if ('ways' in patch && patch.ways === undefined) delete next.ways;
      if ('name' in patch && !patch.name) delete next.name;
      return next;
    }),
  };
}

export function deletePort(part: Part, id: string): Part {
  return { ...part, ports: part.ports.filter((p) => p.id !== id) };
}

/** Change the connector family; ways reset to the family's smallest size when it comes in several. */
export function setPortConnector(part: Part, id: string, connectorId: string, connectors: ConnectorLibrary | null): Part {
  const conn = connectors ? findConnector(connectors, connectorId) : undefined;
  return updatePort(part, id, { connector: connectorId, ways: defaultWays(conn) });
}

export function setExit(part: Part, id: string, dir: ExitDir): Part {
  const port = part.ports.find((p) => p.id === id);
  return port ? updatePort(part, id, { pose: { p_mm: port.pose.p_mm, q: EXIT_QUATS[dir] } }) : part;
}

/** Turn the port half round its own height axis: the cable leaves the other way. */
export function flipExit(part: Part, id: string): Part {
  const port = part.ports.find((p) => p.id === id);
  if (!port) return part;
  const q = new Quaternion(...port.pose.q).multiply(new Quaternion(0, 0, 1, 0)).normalize();
  return updatePort(part, id, { pose: { p_mm: port.pose.p_mm, q: [r7(q.x), r7(q.y), r7(q.z), r7(q.w)] } });
}

/** Move the port along a part axis (0 x, 1 y, 2 z) by `delta_mm`. */
export function nudgePort(part: Part, id: string, axis: 0 | 1 | 2, delta_mm: number): Part {
  const port = part.ports.find((p) => p.id === id);
  if (!port) return part;
  const p: Vec3 = [...port.pose.p_mm];
  p[axis] = r3(p[axis] + delta_mm);
  return updatePort(part, id, { pose: { p_mm: p, q: port.pose.q } });
}

/** Which of the six exit directions the port has now, if any. */
export function exitOf(port: Port): ExitDir | null {
  const d = new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...port.pose.q).normalize());
  const dirs: Array<[ExitDir, Vector3]> = [
    ['+x', new Vector3(1, 0, 0)],
    ['-x', new Vector3(-1, 0, 0)],
    ['+y', new Vector3(0, 1, 0)],
    ['-y', new Vector3(0, -1, 0)],
    ['+z', new Vector3(0, 0, 1)],
    ['-z', new Vector3(0, 0, -1)],
  ];
  return dirs.find(([, v]) => v.dot(d) > 0.999)?.[0] ?? null;
}
