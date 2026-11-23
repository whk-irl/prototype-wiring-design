/**
 * Wires meet ports: a route's first and last point can be attached to a
 * placed component's port (`route.from` / `route.to`). This module looks the
 * port up, gives the plug length the lead-out must clear (the cable cannot
 * bend inside its plug), and checks each attached end:
 *  - fit: can the cable be terminated in that connector (`cableFit`)? A
 *    misfit fails, with the problem sentences; notes are information.
 *  - plug room: the plug box in front of the port must not run into the model
 *    or another part ("the plug at <port> has no room: ...") -> fails.
 *    Exact: the oriented plug box against the model's triangles (BVH) and
 *    other parts' envelope boxes; touching within 0.05 mm is not a clash
 *    (see `plugObstruction`).
 *  - detached: the route end is not at the port and cannot be put back (the
 *    component or port is gone). Ends normally follow their part
 *    (wires/follow.ts) -> warns.
 * Pure apart from the geometry registry (the plug check reads the BVHs).
 */
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import {
  cableFit,
  computeLinkPoses,
  connectorBoxes,
  findConnector,
  findPart,
  meshPoseMatrix,
  poseToMatrix,
  portWays,
  type CableFit,
  type CableType,
  type Component,
  type Connector,
  type ConnectorLibrary,
  type Design,
  type Library,
  type Part,
  type Port,
  type PortRef,
  type Route,
} from '@core';
import { registry } from '../scene/registry';
import { connectorShort } from '../ui/partText';
import { insideMesh } from './solid';
import type { MeshBVH } from 'three-mesh-bvh';

export interface PortInfo {
  component: Component;
  part: Part;
  port: Port;
  connector?: Connector;
  ways?: number;
  /** "Controller / I2C: JST SH 4-way" (short connector label). */
  label: string;
}

export function portInfo(design: Design, library: Library | null, connectors: ConnectorLibrary | null, ref: PortRef | undefined): PortInfo | null {
  if (!ref) return null;
  const component = design.components.find((c) => c.id === ref.component);
  const part = component && library ? findPart(library, component.part) : undefined;
  const port = part?.ports.find((p) => p.id === ref.port);
  if (!component || !part || !port) return null;
  const connector = connectors ? findConnector(connectors, port.connector) : undefined;
  const ways = connector ? portWays(connector, port) : port.ways;
  return { component, part, port, ...(connector ? { connector } : {}), ...(ways !== undefined ? { ways } : {}), label: `${component.name} / ${port.name ?? port.id}: ${connectorShort(port, connectors)}` };
}

/** The stiff length in front of a port the cable cannot bend in: the plug's length (0 when not known). */
export function plugLength(connector: Connector | undefined, ways: number | undefined): number {
  if (!connector || !ways) return 0;
  return connectorBoxes(connector, ways).plug?.[0] ?? 0;
}

/** World matrix of a port frame at a pose (+X is the way the cable leaves). */
export function portWorldMatrix(design: Design, info: PortInfo, values: Readonly<Record<string, number>>): Matrix4 | null {
  const link = computeLinkPoses(design.scene, values).get(info.component.link);
  if (!link) return null;
  return link.clone().multiply(poseToMatrix(info.component.pose)).multiply(poseToMatrix(info.port.pose));
}

/** The attached ends of a route, with their port. */
export function attachedEnds(design: Design, library: Library | null, connectors: ConnectorLibrary | null, route: Route): Array<{ end: 'from' | 'to'; ref: PortRef; info: PortInfo | null }> {
  const out: Array<{ end: 'from' | 'to'; ref: PortRef; info: PortInfo | null }> = [];
  if (route.from) out.push({ end: 'from', ref: route.from, info: portInfo(design, library, connectors, route.from) });
  if (route.to) out.push({ end: 'to', ref: route.to, info: portInfo(design, library, connectors, route.to) });
  return out;
}

/** Can `count` cables of `type` go into this port? Unknown connector: fits, with a note. */
export function fitAtPort(info: PortInfo, type: CableType, count: number): CableFit {
  if (!info.connector) return { fits: true, problems: [], notes: [`Connector "${info.port.connector}" is not in the connector library, so the cable was not checked against it.`] };
  return cableFit(info.connector, info.ways, type, count);
}

/** Fit of a type at every attached end of a route: undefined when the route has none. */
export function routePortFit(
  design: Design,
  library: Library | null,
  connectors: ConnectorLibrary | null,
  route: Route | undefined,
  type: CableType,
  count: number,
): { fits: boolean; problems: string[] } | undefined {
  if (!route) return undefined;
  const ends = attachedEnds(design, library, connectors, route).filter((e) => e.info);
  if (ends.length === 0) return undefined;
  const problems: string[] = [];
  for (const e of ends) for (const p of fitAtPort(e.info!, type, count).problems) problems.push(`${e.info!.port.name ?? e.info!.port.id}: ${p}`);
  return { fits: problems.length === 0, problems };
}

/** Drop the port attachment of a route end (it was edited off the port). */
export function detachEnd(route: Route, end: 'from' | 'to'): Route {
  if (!route[end]) return route;
  const next = { ...route };
  delete next[end];
  return next;
}

export interface EndCheck {
  end: 'from' | 'to';
  label: string;
  /** Problems that make it fail (misfit, no room for the plug), one sentence each. */
  problems: string[];
  /** Information (contacts unused, gauge not recorded...). */
  notes: string[];
  /** The route end is no longer at the port. */
  detached: boolean;
}

/** How far inside the plug box an obstacle must reach to count (touching faces are not a clash). */
export const PLUG_CONTACT_TOLERANCE_MM = 0.05;

/**
 * What the plug box in front of a port runs into at a pose, or null. Exact:
 * the oriented plug box (shrunk by `PLUG_CONTACT_TOLERANCE_MM` on every side)
 * is tested against every triangle of the model through its BVH
 * (`intersectsBox`), and its centre for lying inside a closed mesh (a plug
 * entirely inside a solid crosses no triangle); against other placed parts,
 * their envelope box (oriented box against oriented box). The part the port
 * belongs to is left out.
 */
export function plugObstruction(design: Design, library: Library | null, info: PortInfo, values: Readonly<Record<string, number>>): string | null {
  const plug = info.connector && info.ways ? connectorBoxes(info.connector, info.ways).plug : undefined;
  const m = portWorldMatrix(design, info, values);
  if (!plug || !m) return null;
  const t = PLUG_CONTACT_TOLERANCE_MM;
  const [len, w, h] = plug;
  if (len <= 2 * t || w <= 2 * t || h <= 2 * t) return null;
  // The plug in its port frame: x from the mouth out, centred in y and z.
  const box = new Box3(new Vector3(t, -w / 2 + t, -h / 2 + t), new Vector3(len - t, w / 2 - t, h / 2 - t));
  const centre = box.getCenter(new Vector3()).applyMatrix4(m);
  const poses = computeLinkPoses(design.scene, values);
  // The model's meshes.
  for (const link of design.scene.links) {
    const lw = poses.get(link.id);
    if (!lw) continue;
    for (const ref of link.meshes) {
      const e = registry.get(ref.id);
      const bvh = e?.geometry.boundsTree as unknown as MeshBVH | undefined;
      if (!e || !bvh) continue;
      const inv = lw.clone().multiply(meshPoseMatrix(ref)).invert();
      if (bvh.intersectsBox(box, inv.clone().multiply(m))) return ref.id;
      if (insideMesh(bvh, e.geometry, centre.clone().applyMatrix4(inv)).inside) return ref.id;
    }
  }
  // Other placed parts (their envelope boxes).
  const plugObb = new OBB().fromBox3(box).applyMatrix4(m);
  for (const c of design.components) {
    if (c.id === info.component.id) continue;
    const part = library ? findPart(library, c.part) : undefined;
    const lw = poses.get(c.link);
    if (!part || !lw) continue;
    const [sx, sy, sz] = part.body.size_mm;
    const env = new OBB().fromBox3(new Box3(new Vector3(-sx / 2, -sy / 2, 0), new Vector3(sx / 2, sy / 2, sz))).applyMatrix4(lw.clone().multiply(poseToMatrix(c.pose)));
    if (env.intersectsOBB(plugObb)) return c.name || c.id;
  }
  return null;
}

/** Checks for every attached end of a route. `endPoints`: the route's first and last points in world. */
export function endChecks(
  design: Design,
  library: Library | null,
  connectors: ConnectorLibrary | null,
  route: Route,
  type: CableType,
  count: number,
  values: Readonly<Record<string, number>>,
  endPoints: { first: Vector3; last: Vector3 } | null,
): EndCheck[] {
  return attachedEnds(design, library, connectors, route).map(({ end, ref, info }) => {
    if (!info) return { end, label: `${ref.component} / ${ref.port}`, problems: [`The port ${ref.port} on ${ref.component} no longer exists.`], notes: [], detached: true };
    const fit = fitAtPort(info, type, count);
    const problems = [...fit.problems];
    const where = info.port.name ?? info.port.id;
    const blocked = plugObstruction(design, library, info, values);
    if (blocked) problems.push(`The plug at ${where} has no room: it runs into ${blocked}.`);
    let detached = false;
    const m = portWorldMatrix(design, info, values);
    const at = endPoints ? (end === 'from' ? endPoints.first : endPoints.last) : null;
    if (m && at) detached = new Vector3().setFromMatrixPosition(m).distanceTo(at) > 0.5;
    return { end, label: info.label, problems, notes: fit.notes, detached };
  });
}

/** Port frame +X in the component's link frame (the way the cable leaves). */
export function portExit(component: Component, port: Port): Vector3 {
  return new Vector3(1, 0, 0).applyQuaternion(new Quaternion(...port.pose.q).normalize()).applyQuaternion(new Quaternion(...component.pose.q).normalize()).normalize();
}
