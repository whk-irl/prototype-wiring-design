/** Placed components: one holder group per component inside its link group. */
import { Color, Group, Matrix4, Mesh, type Intersection, type Object3D, type Raycaster, Vector3 } from 'three';
import { findPart, poseToMatrix, type Component, type ConnectorLibrary, type Design, type Library, type Part, type Pose } from '@core';
import { buildPartVisual, disposeObject, type PartVisual } from './partVisual';

interface Entry {
  component: Component;
  holder: Group;
  visual: PartVisual;
  /** What the visual was built from: a new part definition or connector library rebuilds it. */
  part: Part;
  connectors: ConnectorLibrary | null;
  boxes: boolean;
}

export interface ComponentDraft {
  componentId: string;
  linkId: string;
  pose: Pose;
}

export interface ComponentHit {
  componentId: string;
  portId?: string;
  distance: number;
}

const SELECT = new Color(0x2a5fa0);
const HOVER = new Color(0x1c2a3a);
const WARN = new Color(0.18, 0.08, 0);
const NONE = new Color(0, 0, 0);

export class ComponentLayer {
  private entries = new Map<string, Entry>();
  private draft: ComponentDraft | null = null;

  constructor(
    private linkGroup: (id: string) => Group | undefined,
    /** The connector library (for housings on boards), read when a visual is built. */
    private connectors: () => ConnectorLibrary | null = () => null,
    /** A model arrived: redraw. */
    private onChange: () => void = () => {},
    /** A model could not be loaded (once per model). */
    private onModelFail: (part: Part, uri: string, message: string, missing: boolean) => void = () => {},
    /** The part whose ports are being edited: its components show their connector boxes. */
    private editingPart: () => string | null = () => null,
  ) {}

  setDraft(draft: ComponentDraft | null): void {
    this.draft = draft;
  }

  sync(design: Design, library: Library | null, force = false): void {
    const live = new Set<string>();
    for (const c of design.components) {
      const part = library ? findPart(library, c.part) : undefined;
      if (!part) continue;
      live.add(c.id);
      let e = this.entries.get(c.id);
      const boxes = this.editingPart() === c.part;
      if (e && (e.component.part !== c.part || e.part !== part || e.connectors !== this.connectors() || e.boxes !== boxes)) {
        this.remove(c.id);
        e = undefined;
      }
      if (!e) {
        const visual = buildPartVisual(part, { connectors: this.connectors(), showConnectorBoxes: boxes, onModel: this.onChange, onModelFail: (uri, message, missing) => this.onModelFail(part, uri, message, missing) });
        const holder = new Group();
        holder.matrixAutoUpdate = false;
        holder.userData.componentId = c.id;
        holder.add(visual.group);
        visual.body.userData.componentId = c.id;
        for (const m of visual.portMarkers) m.userData.componentId = c.id;
        e = { component: c, holder, visual, part, connectors: this.connectors(), boxes };
        this.entries.set(c.id, e);
        force = true;
      }
      const d = this.draft?.componentId === c.id ? this.draft : null;
      const linkId = d ? d.linkId : c.link;
      const pose = d ? d.pose : c.pose;
      const group = this.linkGroup(linkId);
      if (!group) {
        e.holder.removeFromParent();
        continue;
      }
      if (e.holder.parent !== group) group.add(e.holder);
      if (force || d || e.component !== c || e.holder.userData.drafted) {
        poseToMatrix(pose, e.holder.matrix);
        e.holder.matrixWorldNeedsUpdate = true;
      }
      e.holder.userData.drafted = !!d;
      e.component = c;
    }
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.remove(id);
  }

  private remove(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.holder.removeFromParent();
    disposeObject(e.holder);
    this.entries.delete(id);
  }

  highlight(selected: string | null, hovered: string | null, warnings: Record<string, string[]>): void {
    for (const [id, e] of this.entries) {
      e.visual.setEmissive(id === selected ? SELECT : id === hovered ? HOVER : warnings[id]?.length ? WARN : NONE);
    }
  }

  /** Nearest component body or port marker along the raycaster's ray. */
  pick(raycaster: Raycaster): ComponentHit | null {
    const targets = [];
    for (const e of this.entries.values()) {
      if (!e.holder.parent?.visible) continue;
      targets.push(e.visual.body, ...e.visual.portMarkers);
    }
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    // Prefer a port marker if it is about as near as the body it sits on.
    const first = hits[0]!;
    const port = hits.find((h) => h.object.userData.portId && h.distance < first.distance + 3);
    const h = port ?? first;
    return {
      componentId: h.object.userData.componentId as string,
      portId: h.object.userData.portId as string | undefined,
      distance: h.distance,
    };
  }

  /**
   * Where a ray meets the real surface (model, or board, or the box when the
   * part has neither) of a placed component of `partId`: the point and the
   * surface normal in the PART frame, facing the ray.
   */
  pickSurface(raycaster: Raycaster, partId: string): { componentId: string; point: Vector3; normal: Vector3 } | null {
    let best: { componentId: string; hit: Intersection; holder: Group } | null = null;
    for (const [id, e] of this.entries) {
      if (e.component.part !== partId || !e.holder.parent?.visible) continue;
      e.holder.updateWorldMatrix(true, true);
      const meshes: Mesh[] = [];
      if (e.visual.kind() === 'box') meshes.push(e.visual.body);
      else
        e.visual.group.traverse((o) => {
          let p: Object3D | null = o;
          while (p && !p.userData.partSurface) p = p.parent;
          if (p && (o as Mesh).isMesh) meshes.push(o as Mesh);
        });
      const hits: Intersection[] = [];
      for (const m of meshes) Mesh.prototype.raycast.call(m, raycaster, hits);
      for (const h of hits) if (!best || h.distance < best.hit.distance) best = { componentId: id, hit: h, holder: e.holder };
    }
    if (!best || !best.hit.face) return null;
    const toPart = best.holder.matrixWorld.clone().invert();
    const point = best.hit.point.clone().applyMatrix4(toPart);
    const normal = best.hit.face.normal.clone().transformDirection(best.hit.object.matrixWorld);
    if (normal.dot(raycaster.ray.direction) > 0) normal.negate();
    normal.transformDirection(toPart);
    return { componentId: best.componentId, point, normal };
  }

  worldMatrix(componentId: string): Matrix4 | undefined {
    const e = this.entries.get(componentId);
    if (!e || !e.holder.parent) return undefined;
    e.holder.updateWorldMatrix(true, false);
    return e.holder.matrixWorld.clone();
  }

  reattach(design: Design, library: Library | null): void {
    for (const e of this.entries.values()) e.holder.removeFromParent();
    this.sync(design, library, true);
  }

  holder(componentId: string): Group | undefined {
    return this.entries.get(componentId)?.holder;
  }

  /** Put every component back at its pose (after a trial preview). */
  restorePoses(): void {
    for (const [id, e] of this.entries) {
      const d = this.draft?.componentId === id ? this.draft : null;
      poseToMatrix(d ? d.pose : e.component.pose, e.holder.matrix);
      e.holder.matrixWorldNeedsUpdate = true;
    }
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }
}
