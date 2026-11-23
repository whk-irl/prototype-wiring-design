/**
 * Wires at true size in the viewport. Each run of holds on a body is drawn
 * in its link's group (it moves with the joints): its settled stiff-wire
 * shape, or its drape until that is worked out. Each loop between bodies is
 * drawn in world at the pose shown: its settled shape at its cut length, or,
 * while that is being worked out, the last one it had carried along with the
 * bodies at its ends, see-through (straight, in the error colour, where the
 * length does not reach). The selected wire gets a bright halo; failing
 * stretches are drawn red on the wire itself, tight bends orange and
 * flat-cable folds purple.
 */
import { BackSide, BoxGeometry, BufferGeometry, Color, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, Vector3, type Raycaster } from 'three';
import {
  cableEnvelope,
  cableStiffness,
  computeLinkPoses,
  connectorBoxes,
  findCableType,
  type CableEnvelope,
  type CableLibrary,
  type Design,
  type Route,
} from '@core';
import type { WireStatus } from '../wires/run';
import { planSlack, segmentLine, wireShape } from '../wires/checks';
import { rodOfEnvelope, wirePlan, type RodCable, type WirePlan } from '../wires/settle';
import { attachedEnds, portWorldMatrix } from '../wires/ports';
import { useApp } from '../state/store';
import { bundleOffsets, ribbonGeometry, roundedLine, tubeGeometry, type LinePoint } from '../wires/geometry';
import { routeHolds, routeOfCable, type RoutePoint } from '../wires/routeEdit';

const PLUG_MATERIAL = new MeshStandardMaterial({ color: 0xd8d2c4, transparent: true, opacity: 0.45, depthWrite: false });

/** Distinct, readable on light and dark backgrounds. */
export const WIRE_COLORS = [0xe0502d, 0x2d7fe0, 0x2aa35a, 0xd9a521, 0x9b4fd6, 0x19a8a8, 0xd64f8f, 0x7a8a2a];

export function wireColor(index: number): string {
  return `#${WIRE_COLORS[index % WIRE_COLORS.length]!.toString(16).padStart(6, '0')}`;
}

/** Placeholder envelope for a wire whose type is not in the library. */
const PLACEHOLDER: CableEnvelope = { shape: 'round', width_mm: 2, height_mm: 2, bend_static_mm: 0, length_factor: 1, area_mm2: Math.PI, bend_source: 'generic', notes: [] };

interface WireDraw {
  cableId: string;
  route: Route;
  env: CableEnvelope;
  known: boolean;
  material: MeshStandardMaterial;
  /** Crossings that do not reach at the pose shown: drawn straight in this error colour. */
  shortMaterial: MeshStandardMaterial;
  /** A loop still being worked out at this pose: its last shape, see-through. */
  pendingMaterial: MeshStandardMaterial;
  segmentMeshes: Mesh[];
  crossingMeshes: Mesh[];
  od: number;
  count: number;
  twistPerMm: number;
  /** The cable as a stiff rod, for its settled shape. */
  rod: RodCable;
}

/** The wire's runs and loops (`wirePlan`): settled shapes once worked out (asked for here, solved later). */
function planFor(design: Design, w: { route: Route; rod: RodCable }): WirePlan {
  return wirePlan(design, useApp.getState().library, w.route, w.rod);
}

/** Each run as drawn in its link's frame: the settled stiff-wire shape once it is worked out, the drape until then. */
function localLines(plan: WirePlan, env: CableEnvelope): Array<{ link: string; line: LinePoint[] }> {
  return plan.runs.map((run, k) => ({ link: run.link, line: segmentLine(run.drape, env, plan.settles[k]) }));
}

function wireGeometry(line: readonly LinePoint[], env: CableEnvelope, od: number, count: number, twistPerMm: number): BufferGeometry {
  if (env.shape === 'flat') return ribbonGeometry(line, env.width_mm, env.height_mm);
  const pts = line.map((x) => x.p);
  if (count <= 1) return tubeGeometry(pts, env.width_mm / 2, [[0, 0]], 0, 14);
  const bare = env.width_mm; // sleeve included; offsets are only for display
  return tubeGeometry(pts, od / 2, bundleOffsets(count, od, bare), twistPerMm, 8);
}

export class WireLayer {
  private wires = new Map<string, WireDraw>();
  private markers = new Group();
  private handles: Mesh[] = [];
  private draftMesh: Mesh | null = null;
  /** Marks the first point of the wire being drawn. */
  private draftStart: Mesh | null = null;
  /** Each loop's last settled shape, in the frames of the bodies at its two ends (drawn, dimmed, while the next one is worked out). */
  private lastLoops = new Map<string, { linkA: string; linkB: string; a: Vector3[]; b: Vector3[] }>();

  constructor(
    private linkGroup: (id: string) => Group | undefined,
    private overlay: Group,
  ) {
    this.overlay.add(this.markers);
  }

  private clear(): void {
    for (const w of this.wires.values()) {
      const shared = new Set<unknown>([w.material, w.shortMaterial, w.pendingMaterial, PLUG_MATERIAL]);
      for (const m of [...w.segmentMeshes, ...w.crossingMeshes]) {
        m.removeFromParent();
        m.geometry.dispose();
        // The halo's and the sleeve's own materials.
        if (!shared.has(m.material)) (m.material as MeshStandardMaterial).dispose();
      }
      w.material.dispose();
      w.shortMaterial.dispose();
      w.pendingMaterial.dispose();
    }
    this.wires.clear();
    for (const h of this.handles) {
      h.removeFromParent();
      h.geometry.dispose();
      (h.material as MeshBasicMaterial).dispose();
    }
    this.handles = [];
  }

  /** Rebuild every wire (design, library or selection changed). */
  rebuild(design: Design, lib: CableLibrary | null, values: Readonly<Record<string, number>>, selectedCable: string | null, wirePoint: { cableId: string; index: number } | null): void {
    this.clear();
    design.cables.forEach((cable, i) => {
      const route = routeOfCable(design, cable.id);
      if (!route || route.segments.length === 0) return;
      const type = lib ? findCableType(lib, cable.type) : undefined;
      const env = type ? cableEnvelope(type, cable) : PLACEHOLDER;
      const od = type ? (type.section.shape === 'round' ? type.section.od_mm : type.section.thickness_mm) : 2;
      const material = new MeshStandardMaterial({
        color: type ? new Color(WIRE_COLORS[i % WIRE_COLORS.length]!) : new Color(0x8a8f96),
        // Slightly glossy insulation.
        roughness: 0.35,
        metalness: 0,
        transparent: !type,
        opacity: type ? 1 : 0.55,
      });
      const selected = cable.id === selectedCable;
      if (selected) material.emissive.copy(material.color).multiplyScalar(0.35);
      const shortMaterial = new MeshStandardMaterial({ color: 0xff1a1a, emissive: new Color(0x550000), roughness: 0.6 });
      const pendingMaterial = material.clone();
      pendingMaterial.transparent = true;
      pendingMaterial.opacity = 0.4;
      pendingMaterial.depthWrite = false;
      const twistPerMm = cable.twisted && cable.count > 1 && env.lay_length_mm ? (2 * Math.PI) / env.lay_length_mm : 0;
      const rod: RodCable = type ? { ...rodOfEnvelope(env, cableStiffness(type, cable, env).sag_length_mm), lay_length_mm: cableStiffness(type, cable, env).lay_length_mm } : rodOfEnvelope(env);
      const w: WireDraw = { cableId: cable.id, route, env, known: !!type, material, shortMaterial, pendingMaterial, segmentMeshes: [], crossingMeshes: [], od, count: env.shape === 'flat' ? 1 : cable.count, twistPerMm, rod };
      localLines(planFor(design, w), env).forEach(({ link, line }) => {
        const group = this.linkGroup(link);
        if (!group || line.length < 2) return;
        const mesh = new Mesh(wireGeometry(line, env, od, w.count, twistPerMm), material);
        mesh.userData.cableId = cable.id;
        group.add(mesh);
        w.segmentMeshes.push(mesh);
        // The selected wire: a bright halo around it, so a thin wire reads against the model.
        if (selected) {
          const halo = new Mesh(
            env.shape === 'flat'
              ? ribbonGeometry(line, env.width_mm + 1.2, env.height_mm + 1.2)
              : tubeGeometry(
                  line.map((x) => x.p),
                  env.width_mm / 2 + Math.max(0.5, env.width_mm * 0.2),
                  [[0, 0]],
                  0,
                  14,
                ),
            new MeshBasicMaterial({ color: 0xffd24a, side: BackSide }),
          );
          halo.userData.cableId = cable.id;
          halo.raycast = () => {};
          group.add(halo);
          w.segmentMeshes.push(halo);
        }
        // A sleeve: a see-through jacket of the full envelope.
        if (env.shape === 'round' && cable.sleeve_wall_mm > 0) {
          const sleeve = new Mesh(tubeGeometry(line.map((x) => x.p), env.width_mm / 2, [[0, 0]], 0, 14), new MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.25, depthWrite: false }));
          sleeve.userData.cableId = cable.id;
          group.add(sleeve);
          w.segmentMeshes.push(sleeve);
        }
      });
      this.wires.set(cable.id, w);
      if (cable.id === selectedCable) this.addHandles(route, env, wirePoint?.cableId === cable.id ? wirePoint.index : -1);
    });
    this.updatePose(design, values);
  }

  private addHandles(route: Route, env: CableEnvelope, selected: number): void {
    // Handles on the points that hold the wire (the settled shape passes through them); draped points between them follow.
    const anchors = new Set(routeHolds(route).flatMap((h, i) => (h ? [i] : [])));
    let index = 0;
    const r = Math.max(0.8, env.width_mm * 0.6);
    for (const s of route.segments) {
      const group = this.linkGroup(s.link);
      let last: [number, number, number] | null = null;
      for (const p of s.points_mm) {
        // One handle per place: points wrapped round an edge share their surface point.
        const near = last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < Math.max(1.5, 2 * r);
        if ((!anchors.has(index) || near) && index !== selected) {
          index++;
          continue;
        }
        last = [p[0], p[1], p[2]];
        const h = new Mesh(new SphereGeometry(r, 14, 10), new MeshBasicMaterial({ color: index === selected ? 0xffd24a : 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
        h.position.set(...p);
        h.renderOrder = 25;
        h.userData.handle = index;
        h.userData.cableId = route.cable;
        group?.add(h);
        this.handles.push(h);
        index++;
      }
    }
  }

  /** Joints moved: redraw the crossings. */
  updatePose(design: Design, values: Readonly<Record<string, number>>): void {
    for (const w of this.wires.values()) {
      for (const m of w.crossingMeshes) {
        m.removeFromParent();
        m.geometry.dispose();
      }
      w.crossingMeshes = [];
      this.addPlugGhosts(design, w, values);
      const plan = planFor(design, w);
      if (plan.runs.length < 2) continue;
      // The free cable between holds on different links: re-solved for the pose shown, its length fixed by the slack model.
      const shape = wireShape(design, w.route, w.env, values, planSlack(design, plan, w.env), { rod: w.rod, library: useApp.getState().library, plan });
      const poses = computeLinkPoses(design.scene, values);
      shape.crossings.forEach((c, k) => {
        const linkA = plan.runs[k]!.link;
        const linkB = plan.runs[k + 1]!.link;
        const mA = poses.get(linkA) ?? new Matrix4();
        const mB = poses.get(linkB) ?? new Matrix4();
        const memoKey = `${w.cableId}:${k}`;
        let pts = c.points;
        let dim = false;
        if (c.pending) {
          // Still being worked out at this pose: keep drawing the last settled loop, each end moving with its body, dimmed.
          const last = this.lastLoops.get(memoKey);
          if (last && last.linkA === linkA && last.linkB === linkB && last.a.length === last.b.length && last.a.length > 1) {
            const n = last.a.length - 1;
            pts = last.a.map((p, i) => p.clone().applyMatrix4(mA).lerp(last.b[i]!.clone().applyMatrix4(mB), i / n));
          }
          dim = true;
        } else if (c.reaches) {
          // Remember it in both end bodies' frames, to carry it along while the next pose is worked out.
          const iA = mA.clone().invert();
          const iB = mB.clone().invert();
          this.lastLoops.set(memoKey, { linkA, linkB, a: c.points.map((p) => p.clone().applyMatrix4(iA)), b: c.points.map((p) => p.clone().applyMatrix4(iB)) });
        }
        // A ribbon's flat side follows the surface normals, turning from one end's to the other's.
        const line: LinePoint[] = pts.map((p, i) => ({ p, n: (c.normals[Math.min(i, c.normals.length - 1)] ?? new Vector3()).clone() }));
        const mesh = new Mesh(wireGeometry(line, w.env, w.od, w.count, w.twistPerMm), !c.reaches ? w.shortMaterial : dim ? w.pendingMaterial : w.material);
        mesh.userData.cableId = w.cableId;
        this.overlay.add(mesh);
        w.crossingMeshes.push(mesh);
      });
    }
  }

  /** The plug at each end attached to a port, as a see-through box in front of the port (the cable cannot bend inside it). */
  private addPlugGhosts(design: Design, w: WireDraw, values: Readonly<Record<string, number>>): void {
    const st = useApp.getState();
    for (const { info } of attachedEnds(design, st.library, st.connectorLibrary, w.route)) {
      const plug = info?.connector && info.ways ? connectorBoxes(info.connector, info.ways).plug : undefined;
      const m = info && plug ? portWorldMatrix(design, info, values) : null;
      if (!plug || !m) continue;
      const mesh = new Mesh(new BoxGeometry(plug[0], plug[1], plug[2]).translate(plug[0] / 2, 0, 0), PLUG_MATERIAL);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      mesh.raycast = () => {};
      mesh.renderOrder = 4;
      this.overlay.add(mesh);
      w.crossingMeshes.push(mesh);
    }
  }

  /** Mark check results: collisions red, tight bends orange, the tightest clearance amber. */
  updateMarkers(design: Design, checks: Readonly<Record<string, WireStatus>>, values: Readonly<Record<string, number>>): void {
    for (const m of [...this.markers.children]) {
      m.removeFromParent();
      (m as Mesh).geometry.dispose();
      ((m as Mesh).material as MeshBasicMaterial).dispose();
    }
    const poses = computeLinkPoses(design.scene, values);
    for (const [id, st] of Object.entries(checks)) {
      const w = this.wires.get(id);
      if (!w || !st.known) continue;
      const r = w.env.width_mm / 2;
      // Failing stretches: red over the wire itself (plus a small marker at the worst point).
      if ((st.failing ?? []).length > 0) {
        const lines = this.worldLines(design, w, values);
        for (const f of st.failing!) {
          for (const pts of stretch(lines, f.from_mm - r, f.to_mm + r)) {
            if (pts.length < 2) continue;
            const m = new Mesh(
              w.env.shape === 'flat'
                ? ribbonGeometry(
                    pts.map((p) => ({ p, n: new Vector3() })),
                    w.env.width_mm + 0.4,
                    w.env.height_mm + 0.4,
                  )
                : tubeGeometry(pts, r * 1.12 + 0.1, [[0, 0]], 0, 12),
              new MeshBasicMaterial({ color: 0xff1a1a }),
            );
            m.raycast = () => {};
            m.renderOrder = 21;
            this.markers.add(m);
          }
          this.mark(new Vector3(...f.point), Math.max(0.4, r * 0.6), 0xff1a1a);
        }
      }
      for (const f of st.folds ?? []) {
        const m = poses.get(f.link);
        if (m) this.mark(new Vector3(...f.point).applyMatrix4(m), Math.max(r, w.env.width_mm * 0.3), 0xb04fe0);
      }
      // Tight corners: one marker per place (an edge the wire wraps gives several corners).
      const shown: Vector3[] = [];
      for (const b of st.tightBends ?? []) {
        const m = poses.get(b.link);
        if (!m) continue;
        const at = new Vector3(...b.point).applyMatrix4(m);
        if (shown.some((q) => q.distanceTo(at) < Math.max(3, 4 * r))) continue;
        shown.push(at);
        this.mark(at, r * 1.3, 0xff8c1a);
      }
      if (st.fits && st.tightestAt && st.tightest_mm !== undefined && st.margin_mm !== undefined && st.tightest_mm < st.margin_mm) {
        this.mark(new Vector3(...st.tightestAt), Math.max(0.4, r * 0.5), 0xffd24a);
      }
    }
  }

  /** The drawn wire on links in world at a pose, with the crossings' free lengths as gaps (as the fit check walks it). */
  private worldLines(design: Design, w: WireDraw, values: Readonly<Record<string, number>>): Array<{ pts: Vector3[]; skip: number }> {
    const plan = planFor(design, w);
    const shape = wireShape(design, w.route, w.env, values, planSlack(design, plan, w.env), { rod: w.rod, library: useApp.getState().library, plan });
    return shape.segments.map((sg, i) => ({ pts: sg.line.map((x) => x.p), skip: shape.crossings[i]?.length_mm ?? 0 }));
  }

  private mark(p: Vector3, radius: number, color: number): void {
    const m = new Mesh(new SphereGeometry(Math.max(0.5, radius), 16, 12), new MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false }));
    m.position.copy(p);
    m.renderOrder = 22;
    m.raycast = () => {};
    this.markers.add(m);
  }

  /** The wire being drawn, at true size, through the points so far and the cursor. */
  updateDraft(design: Design, lib: CableLibrary | null, values: Readonly<Record<string, number>>, settings: { type: string; count: number; twisted: boolean; lay_length_mm?: number; sleeve_wall_mm: number }, points: readonly RoutePoint[], firstClick?: RoutePoint): void {
    if (this.draftMesh) {
      this.draftMesh.removeFromParent();
      this.draftMesh.geometry.dispose();
      (this.draftMesh.material as MeshStandardMaterial).dispose();
      this.draftMesh = null;
    }
    if (this.draftStart) {
      this.draftStart.removeFromParent();
      this.draftStart.geometry.dispose();
      (this.draftStart.material as MeshBasicMaterial).dispose();
      this.draftStart = null;
    }
    const type = lib ? findCableType(lib, settings.type) : undefined;
    const poses = computeLinkPoses(design.scene, values);
    // The first point clicked, marked from the first click on (the wire starts there).
    const first = firstClick;
    if (first) {
      const size = type ? Math.max(1.2, cableEnvelope(type, settings).width_mm * 1.2) : 1.5;
      this.draftStart = new Mesh(new SphereGeometry(size, 16, 12), new MeshBasicMaterial({ color: 0x2ecc71, depthTest: false, transparent: true, opacity: 0.9 }));
      this.draftStart.position.set(...first.p).applyMatrix4(poses.get(first.link) ?? new Matrix4());
      this.draftStart.renderOrder = 26;
      this.draftStart.raycast = () => {};
      this.overlay.add(this.draftStart);
    }
    if (!type || points.length < 2) return;
    const env = cableEnvelope(type, settings);
    const line: LinePoint[] = points.map((pt) => {
      const m = poses.get(pt.link) ?? new Matrix4();
      const n = new Vector3(...pt.n);
      const nw = n.lengthSq() > 0 ? n.clone().transformDirection(m) : new Vector3();
      return { p: new Vector3(...pt.p).applyMatrix4(m).addScaledVector(nw, env.height_mm / 2), n: nw };
    });
    const rounded = roundedLine(line, env.bend_static_mm);
    const od = type.section.shape === 'round' ? type.section.od_mm : type.section.thickness_mm;
    const geo = wireGeometry(rounded, env, od, env.shape === 'flat' ? 1 : settings.count, 0);
    this.draftMesh = new Mesh(geo, new MeshStandardMaterial({ color: 0xffd24a, transparent: true, opacity: 0.75 }));
    this.draftMesh.raycast = () => {};
    this.overlay.add(this.draftMesh);
  }

  pickHandle(raycaster: Raycaster): { cableId: string; index: number; distance: number } | null {
    const hits = raycaster.intersectObjects(this.handles, false);
    const h = hits[0];
    return h ? { cableId: h.object.userData.cableId as string, index: h.object.userData.handle as number, distance: h.distance } : null;
  }

  pickWire(raycaster: Raycaster): { cableId: string; distance: number } | null {
    const meshes = [...this.wires.values()].flatMap((w) => [...w.segmentMeshes, ...w.crossingMeshes]);
    const h = raycaster.intersectObjects(meshes, false)[0];
    return h ? { cableId: h.object.userData.cableId as string, distance: h.distance } : null;
  }

  dispose(): void {
    this.clear();
    for (const m of [...this.markers.children]) {
      (m as Mesh).geometry.dispose();
      ((m as Mesh).material as MeshBasicMaterial).dispose();
    }
    this.markers.removeFromParent();
    if (this.draftMesh) {
      this.draftMesh.removeFromParent();
      this.draftMesh.geometry.dispose();
      (this.draftMesh.material as MeshStandardMaterial).dispose();
      this.draftMesh = null;
    }
    if (this.draftStart) {
      this.draftStart.removeFromParent();
      this.draftStart.geometry.dispose();
      (this.draftStart.material as MeshBasicMaterial).dispose();
      this.draftStart = null;
    }
    this.lastLoops.clear();
  }
}

/** The parts of the drawn lines between `from` and `to` mm along the wire. */
function stretch(lines: ReadonlyArray<{ pts: Vector3[]; skip: number }>, from: number, to: number): Vector3[][] {
  const out: Vector3[][] = [];
  let s = 0;
  for (const l of lines) {
    const cur: Vector3[] = [];
    for (let k = 1; k < l.pts.length; k++) {
      const a = l.pts[k - 1]!;
      const b = l.pts[k]!;
      const len = a.distanceTo(b);
      const s0 = s;
      s += len;
      if (s < from || s0 > to || len === 0) continue;
      const t0 = Math.max(0, (from - s0) / len);
      const t1 = Math.min(1, (to - s0) / len);
      if (cur.length === 0) cur.push(a.clone().lerp(b, t0));
      cur.push(a.clone().lerp(b, t1));
    }
    if (cur.length) out.push(cur);
    s += l.skip;
  }
  return out;
}

