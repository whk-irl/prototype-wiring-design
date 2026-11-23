/**
 * Zone overlays: each zone is drawn as a copy of its painted triangles in its
 * link group, pulled towards the camera with a polygon offset. Mount-allowed
 * zones are solid green; keep-out zones are red with diagonal stripes, so the
 * two read apart without colour.
 */
import { BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group, Mesh, ShaderMaterial } from 'three';
import { decodeTriangles, type Design, type Zone, type ZoneKind } from '@core';
import { meshPlacements } from '../scene/placement';
import { registry } from '../scene/registry';

const VERT = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float stripes;
void main() {
  float a = opacity;
  if (stripes > 0.5) {
    float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
    a = mix(opacity * 0.35, opacity * 1.5, s);
  }
  gl_FragColor = vec4(color, clamp(a, 0.0, 1.0));
}`;

export const ZONE_COLORS: Record<ZoneKind, string> = { mount_allowed: '#22b14c', keep_out: '#e5322b' };

function makeMaterial(kind: ZoneKind): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      color: { value: new Color(ZONE_COLORS[kind]) },
      opacity: { value: 0.45 },
      stripes: { value: kind === 'keep_out' ? 1 : 0 },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}

interface Entry {
  mesh: Mesh;
  material: ShaderMaterial;
  capacity: number;
  /** What the overlay currently shows. */
  source: Zone | Uint8Array | null;
  kind: ZoneKind;
  meshId: string;
}

/** Live triangles of a zone being painted, shown instead of the design's. */
export interface ZoneDraft {
  zoneId: string;
  meshId: string;
  linkId: string;
  kind: ZoneKind;
  mask: Uint8Array;
}

export class ZoneLayer {
  private entries = new Map<string, Entry>();
  private draft: ZoneDraft | null = null;

  constructor(private linkGroup: (id: string) => Group | undefined) {}

  setDraft(draft: ZoneDraft | null): void {
    this.draft = draft;
  }

  /** Bring overlays in line with the design (and the draft). */
  sync(design: Design, hidden: Record<string, true>, selectedZone: string | null, force = false): void {
    const live = new Set<string>();
    const zones: Array<{ id: string; mesh: string; link: string; kind: ZoneKind; source: Zone | Uint8Array }> = design.zones.map((z) => ({
      id: z.id,
      mesh: z.mesh,
      link: z.link,
      kind: z.kind,
      source: z,
    }));
    const d = this.draft;
    if (d) {
      const i = zones.findIndex((z) => z.id === d.zoneId);
      const item = { id: d.zoneId, mesh: d.meshId, link: d.linkId, kind: d.kind, source: d.mask };
      if (i >= 0) zones[i] = item;
      else zones.push(item);
    }
    const placements = meshPlacements(design);
    for (const z of zones) {
      // The overlay copies imported triangles, so it sits in the link at the mesh's pose.
      const placement = placements.get(z.mesh);
      const group = this.linkGroup(placement?.link ?? z.link);
      const meshEntry = registry.get(z.mesh);
      if (!group || !meshEntry) continue;
      live.add(z.id);
      let e = this.entries.get(z.id);
      if (e && e.kind !== z.kind) {
        e.material.dispose();
        e.material = makeMaterial(z.kind);
        e.mesh.material = e.material;
        e.kind = z.kind;
      }
      if (!e) {
        const material = makeMaterial(z.kind);
        const mesh = new Mesh(new BufferGeometry(), material);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = 2;
        mesh.frustumCulled = false;
        mesh.raycast = () => {};
        mesh.userData.zoneId = z.id;
        e = { mesh, material, capacity: 0, source: null, kind: z.kind, meshId: z.mesh };
        this.entries.set(z.id, e);
      }
      e.meshId = z.mesh;
      if (e.mesh.parent !== group) group.add(e.mesh);
      if (placement) e.mesh.matrix.copy(placement.pose);
      else e.mesh.matrix.identity();
      e.mesh.matrixWorldNeedsUpdate = true;
      if (force || e.source !== z.source || z.source instanceof Uint8Array) this.fill(e, z.mesh, z.source);
      e.mesh.visible = !hidden[z.id];
      e.material.uniforms.opacity!.value = selectedZone === z.id ? 0.62 : 0.42;
    }
    for (const [id, e] of this.entries) {
      if (live.has(id)) continue;
      e.mesh.removeFromParent();
      e.mesh.geometry.dispose();
      e.material.dispose();
      this.entries.delete(id);
    }
  }

  /** Re-attach overlays after link groups were rebuilt. */
  reattach(design: Design, hidden: Record<string, true>, selectedZone: string | null): void {
    this.sync(design, hidden, selectedZone, true);
  }

  private fill(e: Entry, meshId: string, source: Zone | Uint8Array): void {
    e.source = source;
    const src = registry.get(meshId)!.geometry;
    const pos = src.getAttribute('position');
    const index = src.getIndex();
    let tris: ArrayLike<number>;
    if (source instanceof Uint8Array) {
      const list: number[] = [];
      for (let t = 0; t < source.length; t++) if (source[t]) list.push(t);
      tris = list;
    } else {
      tris = decodeTriangles(source.triangles);
    }
    const n = tris.length;
    if (n > e.capacity) {
      e.mesh.geometry.dispose();
      const g = new BufferGeometry();
      e.capacity = Math.max(64, Math.ceil(n * 1.5));
      g.setAttribute('position', new Float32BufferAttribute(new Float32Array(e.capacity * 9), 3));
      e.mesh.geometry = g;
    }
    const g = e.mesh.geometry;
    const attr = g.getAttribute('position') as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    let o = 0;
    for (let k = 0; k < n; k++) {
      const t = tris[k]!;
      for (let v = 0; v < 3; v++) {
        const vi = index ? index.getX(3 * t + v) : 3 * t + v;
        arr[o++] = pos.getX(vi);
        arr[o++] = pos.getY(vi);
        arr[o++] = pos.getZ(vi);
      }
    }
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, o);
    attr.needsUpdate = true;
    g.setDrawRange(0, n * 3);
  }

  /** Overlays drawn on the given meshes (to move them with a trial preview). */
  overlaysOn(meshIds: ReadonlySet<string>): Mesh[] {
    return [...this.entries.values()].filter((e) => meshIds.has(e.meshId)).map((e) => e.mesh);
  }

  /** Put every overlay back at its mesh's pose (after a trial preview). */
  restorePoses(design: Design): void {
    const placements = meshPlacements(design);
    for (const e of this.entries.values()) {
      const pl = placements.get(e.meshId);
      if (pl) e.mesh.matrix.copy(pl.pose);
      e.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.mesh.removeFromParent();
      e.mesh.geometry.dispose();
      e.material.dispose();
    }
    this.entries.clear();
  }
}
