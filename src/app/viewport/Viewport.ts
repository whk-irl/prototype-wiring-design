/**
 * The 3D viewport: plain three.js driven imperatively, rendered on demand.
 *
 * Scene layout: one `modelRoot` holding one Group per link as siblings. Each
 * link group has `matrixAutoUpdate = false` and its matrix comes only from
 * `computeLinkPoses`. Meshes sit in their link group at identity, since
 * imported geometry is already in the link frame.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  ArrowHelper,
  Box3,
  Color,
  DirectionalLight,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  PCFShadowMap,
  PlaneGeometry,
  ShadowMaterial,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Ray,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { computeLinkPoses, meshPoseMatrix, subtreeLinks, type Design } from '@core';
import { meshPlacements, resolveHit } from '../scene/placement';
import { AxisGizmo } from './axisGizmo';
import { registry } from '../scene/registry';
import { useApp, type AppState } from '../state/store';
import type { RayHit, Tool, ToolContext, ToolPointerEvent } from '../tools/types';
import { ComponentLayer, type ComponentHit } from './componentLayer';
import { AxesGizmo, Grid, currentTheme, type Theme } from './helpers';
import { WireLayer } from './wireLayer';
import { ZoneLayer } from './zoneLayer';

export type StandardView = 'top' | 'front' | 'right' | 'iso';

const VIEW_DIRS: Record<StandardView, Vector3> = {
  // Camera position relative to the target. Top is nudged off the pole so
  // OrbitControls keeps a well-defined azimuth.
  top: new Vector3(0, -1e-4, 1),
  front: new Vector3(0, -1, 0),
  right: new Vector3(1, 0, 0),
  iso: new Vector3(1, -1, 0.8),
};

const HOVER_EMISSIVE = new Color(0x1c2a3a);
const SELECT_EMISSIVE = new Color(0x1e4f8c);
const SELECT_EMISSIVE_DARK = new Color(0x2a5fa0);
const CLICK_SLOP_PX = 4;
/**
 * Above this many triangles the model gets no feature edges and casts no
 * shadow: both cost time on every change of pose, and a big STEP model must
 * stay quick to orbit.
 */
export const DETAIL_TRIANGLE_BUDGET = 400_000;
/** Angle between faces above which an edge is drawn, degrees (CAD-style feature edges). */
const EDGE_ANGLE_DEG = 30;

export interface FrameStats {
  fps: number;
  /** Mean CPU time of render() in ms over the last second. */
  frameMs: number;
  /** Mean interval between rendered frames in ms. */
  intervalMs: number;
}

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Root of all link groups. */
  readonly modelRoot = new Group();
  /** World-space scratch layer for tools (previews, gizmos). Not pickable. */
  readonly overlay = new Group();
  /** Zone overlays (painted triangles). */
  readonly zones: ZoneLayer;
  /** Placed components. */
  readonly components: ComponentLayer;
  /** Wires at true size. */
  readonly wires: WireLayer;
  private hoverComponent: string | null = null;
  private axisGizmo = new AxisGizmo();
  /** A suggested axis the pointer is over in the joint editor. */
  private hoverAxisGizmo = new AxisGizmo(0x18b0ff);

  private container: HTMLElement;
  private grid: Grid;
  private gizmo = new AxesGizmo();
  private theme: Theme;
  /** Key light, riding with the camera: faces towards the viewer read brighter. */
  private headlight = new DirectionalLight(0xffffff, 1.7);
  private hemi = new HemisphereLight(0xffffff, 0x8a8f96, 1.1);
  /** Fill light fixed above the model; it alone casts the soft ground shadow (redrawn only when something moves). */
  private sun = new DirectionalLight(0xffffff, 0.7);
  private ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: 0.16, depthWrite: false }));
  private edgeMaterial = new LineBasicMaterial({ color: 0x3b4048, transparent: true, opacity: 0.55 });
  /** The model is small enough for edges and shadows. */
  private detail = true;
  private linkGroups = new Map<string, Group>();
  private meshObjects = new Map<string, Mesh>();
  private pickables: Mesh[] = [];
  private jointArrow: ArrowHelper | null = null;
  private raycaster = new Raycaster();
  private modelSphere = new Sphere(new Vector3(), 500);

  private dirty = false;
  private frameRequested = false;
  private autospin = false;
  private disposed = false;
  private unsubscribe: Array<() => void> = [];
  private resizeObserver: ResizeObserver;
  /** Set after the first resize (the camera's starting aspect is a placeholder). */
  private sized = false;
  private lastWidth = 0;
  private mql: MediaQueryList | null = null;

  private tool: Tool | null = null;
  private captured = false;
  private down: { x: number; y: number; t: number; button: number } | null = null;
  private pendingMove: PointerEvent | null = null;

  private frameTimes: number[] = [];
  private renderCost: number[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.theme = currentTheme();
    // Transparent canvas: the page draws the theme's background gradient behind it.
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    // Shadows are drawn again only when the model, a pose or a part changes, never just for orbiting.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.domElement.className = 'viewport-canvas';
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('aria-label', '3D view. Drag to orbit, right-drag to pan, wheel to zoom.');
    container.appendChild(this.renderer.domElement);

    this.camera = new PerspectiveCamera(40, 1, 1, 100_000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(800, -800, 640);

    this.scene.background = null;
    this.hemi.position.set(0, 0, 1);
    this.sun.position.set(0.35, -0.45, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.radius = 6;
    this.sun.shadow.bias = -0.0005;
    this.ground.receiveShadow = true;
    this.ground.raycast = () => {};
    this.ground.renderOrder = -3;
    this.edgeMaterial.color.copy(this.theme.edge);
    this.scene.add(this.hemi, new AmbientLight(0xffffff, 0.2), this.sun, this.sun.target, this.ground, this.camera);
    // Headlight from above-left of the viewer, so faces facing the camera read
    // brighter than faces turned away.
    this.headlight.position.set(-0.4, 0.6, 1);
    this.camera.add(this.headlight, this.headlight.target);
    this.headlight.target.position.set(0, 0, -1);

    this.zones = new ZoneLayer((id) => this.linkGroups.get(id));
    this.components = new ComponentLayer(
      (id) => this.linkGroups.get(id),
      () => useApp.getState().connectorLibrary,
      () => this.requestRender(),
      (part, uri, message, missing) =>
        missing
          ? useApp
              .getState()
              .notify('warning', `The 3D model of "${part.name}" is not on this PC`, [
                `To see its real shape, open its part file (Parts > Add your own part > a part file exported from this app). Until then it is drawn from its outline.`,
              ])
          : useApp.getState().notify('warning', `The 3D model of "${part.name}" could not be loaded`, [`${uri}: ${message}`, 'The part is drawn from its outline instead.']),
      () => useApp.getState().editingPart,
    );
    this.wires = new WireLayer((id) => this.linkGroups.get(id), this.overlay);
    this.grid = new Grid(this.theme);
    this.scene.add(this.grid, this.modelRoot, this.overlay);
    this.overlay.add(this.axisGizmo, this.hoverAxisGizmo);

    // Our pointer listeners are attached before OrbitControls' so a tool can
    // capture a drag before the camera starts moving.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('pointercancel', this.onPointerCancel);
    el.addEventListener('lostpointercapture', this.onPointerCancel);
    el.addEventListener('dblclick', this.onDoubleClick);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    this.controls = new OrbitControls(this.camera, el);
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0;
    this.controls.maxDistance = Infinity;
    this.controls.addEventListener('change', () => this.requestRender());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    if (typeof matchMedia !== 'undefined') {
      this.mql = matchMedia('(prefers-color-scheme: dark)');
      this.mql.addEventListener('change', this.onThemeChange);
    }
    window.addEventListener('wd-theme', this.onThemeChange);

    this.unsubscribe.push(useApp.subscribe(this.onStoreChange));
    this.rebuildMeshes();
    this.updatePoses();
    this.updateHighlight();
    this.updateJointArrow(useApp.getState().design);
    if (registry.size > 0) this.onModelLoaded();
  }

  // ------------------------------------------------------------ lifecycle

  dispose(): void {
    this.disposed = true;
    this.tool?.deactivate?.(this.ctx());
    for (const u of this.unsubscribe) u();
    this.resizeObserver.disconnect();
    this.mql?.removeEventListener('change', this.onThemeChange);
    window.removeEventListener('wd-theme', this.onThemeChange);
    this.controls.dispose();
    this.zones.dispose();
    this.components.dispose();
    this.wires.dispose();
    for (const m of this.meshObjects.values()) this.disposeMesh(m);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private ctx(): ToolContext {
    return { viewport: this, store: useApp, registry };
  }

  /** Ask for one frame. Cheap to call many times per frame. */
  requestRender(): void {
    this.dirty = true;
    if (this.frameRequested || this.disposed) return;
    this.frameRequested = true;
    requestAnimationFrame(this.frame);
  }

  setAutospin(on: boolean): void {
    this.autospin = on;
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = 4;
    this.requestRender();
  }

  private frame = (): void => {
    this.frameRequested = false;
    if (this.disposed) return;
    if (this.pendingMove) {
      const e = this.pendingMove;
      this.pendingMove = null;
      this.dispatchMove(e);
    }
    if (this.autospin) this.controls.update();
    if (!this.dirty && !this.autospin) return;
    this.dirty = false;
    const t0 = performance.now();
    this.render();
    const t1 = performance.now();
    this.recordFrame(t1, t1 - t0);
    if (this.autospin) this.requestRender();
  };

  private render(): void {
    const { renderer, camera } = this;
    this.updateClipping();
    const size = renderer.getSize(new Vector2());
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.render(this.scene, camera);
    this.gizmo.render(renderer, camera, size.y);
  }

  private recordFrame(now: number, cost: number): void {
    this.frameTimes.push(now);
    this.renderCost.push(cost);
    while (this.frameTimes.length > 0 && now - this.frameTimes[0]! > 1000) {
      this.frameTimes.shift();
      this.renderCost.shift();
    }
  }

  /** Frame statistics over the last second. Meaningful while frames are continuous. */
  getStats(): FrameStats {
    const n = this.frameTimes.length;
    const now = performance.now();
    if (n < 2 || now - this.frameTimes[n - 1]! > 250) return { fps: 0, frameMs: 0, intervalMs: 0 };
    const span = this.frameTimes[n - 1]! - this.frameTimes[0]!;
    const intervalMs = span / (n - 1);
    const frameMs = this.renderCost.reduce((a, b) => a + b, 0) / n;
    return { fps: 1000 / intervalMs, frameMs, intervalMs };
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    const before = this.camera.aspect;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // The window or a panel resized: keep what is in view across (the width at the target) the same, stepping back when the
    // view narrows and in again when it widens, so the model stays in view and a narrow-then-wide round trip ends where it began.
    // Only a change of width: a bar appearing above or below the view changes its height, and the vertical field of view
    // already keeps what is in view up and down.
    const ratio = Math.abs(w - this.lastWidth) > 0.5 ? before / this.camera.aspect : 1;
    this.lastWidth = w;
    if (Number.isFinite(ratio) && Math.abs(ratio - 1) > 1e-6 && this.controls && this.sized) {
      const dir = this.camera.position.clone().sub(this.controls.target);
      this.camera.position.copy(this.controls.target).addScaledVector(dir, Math.min(3, Math.max(1 / 3, ratio)));
      this.controls.update();
    }
    this.sized = true;
    this.requestRender();
  }

  /** Near and far planes that suit models from 20 mm to 5 m at any zoom. */
  private updateClipping(): void {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const toCentre = this.camera.position.distanceTo(this.modelSphere.center);
    const r = this.modelSphere.radius;
    const near = Math.max(0.01, Math.min(dist, Math.max(toCentre - r, 0)) * 0.05, dist * 0.002);
    const far = Math.max(toCentre + r * 2, dist) * 4 + this.grid.spacing.extent * 2;
    if (Math.abs(near - this.camera.near) > 1e-9 || Math.abs(far - this.camera.far) > 1e-6) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  private onThemeChange = (): void => {
    this.theme = currentTheme();
    this.grid.setTheme(this.theme);
    this.edgeMaterial.color.copy(this.theme.edge);
    this.updateHighlight();
  };

  // ------------------------------------------------------------ store sync

  private onStoreChange = (s: AppState, prev: AppState): void => {
    const linksChanged = s.design.scene.links !== prev.design.scene.links || s.geometryVersion !== prev.geometryVersion;
    if (linksChanged) this.rebuildMeshes();
    if (s.viewGrid !== prev.viewGrid) {
      this.grid.visible = s.viewGrid;
      this.requestRender();
    }
    if (s.viewEdges !== prev.viewEdges) this.setEdges(s.viewEdges);
    const selZone = s.selection?.kind === 'zone' ? s.selection.id : null;
    const prevSelZone = prev.selection?.kind === 'zone' ? prev.selection.id : null;
    if (linksChanged) {
      this.zones.reattach(s.design, s.hiddenZones, selZone);
      this.components.reattach(s.design, s.library);
    } else {
      if (s.design.zones !== prev.design.zones || s.hiddenZones !== prev.hiddenZones || selZone !== prevSelZone) {
        this.zones.sync(s.design, s.hiddenZones, selZone);
        this.requestRender();
      }
      if (s.design.components !== prev.design.components || s.library !== prev.library || s.connectorLibrary !== prev.connectorLibrary || s.editingPart !== prev.editingPart) {
        this.components.sync(s.design, s.library);
        this.requestRender();
      }
    }
    const selCable = s.selection?.kind === 'cable' ? s.selection.id : null;
    const prevSelCable = prev.selection?.kind === 'cable' ? prev.selection.id : null;
    if (
      linksChanged ||
      s.design.cables !== prev.design.cables ||
      s.design.routes !== prev.design.routes ||
      s.design.scene.joints !== prev.design.scene.joints ||
      s.cableLibrary !== prev.cableLibrary ||
      s.shapeVersion !== prev.shapeVersion ||
      s.design.components !== prev.design.components ||
      s.library !== prev.library ||
      s.connectorLibrary !== prev.connectorLibrary ||
      selCable !== prevSelCable ||
      s.wirePoint !== prev.wirePoint
    ) {
      this.wires.rebuild(s.design, s.cableLibrary, s.jointValues, selCable, s.wirePoint);
      this.wires.updateMarkers(s.design, s.wireChecks, s.jointValues);
      this.requestRender();
    } else if (s.wireChecks !== prev.wireChecks) {
      this.wires.updateMarkers(s.design, s.wireChecks, s.jointValues);
      this.requestRender();
    }
    if (s.wireDraft !== prev.wireDraft || s.wireSettings !== prev.wireSettings || (s.wireDraft && s.jointValues !== prev.jointValues)) {
      const d = s.wireDraft;
      this.wires.updateDraft(s.design, s.cableLibrary, s.jointValues, s.wireSettings, d ? [...d.points, ...(d.cursor ? [d.cursor] : [])] : [], d?.points[0]);
      this.requestRender();
    }
    if (s.hiddenMeshes !== prev.hiddenMeshes) {
      for (const [id, mesh] of this.meshObjects) mesh.visible = !s.hiddenMeshes[id];
      this.pickables = [...this.meshObjects.values()].filter((m) => m.parent?.visible && m.visible);
      this.requestRender();
    }
    if (s.jointDraft !== prev.jointDraft && !linksChanged) this.updatePoses();
    if (s.axisHover !== prev.axisHover) {
      this.hoverAxisGizmo.show(s.axisHover?.point ?? null, s.axisHover?.dir ?? null, this.modelSphere.radius * 1.1);
      this.requestRender();
    }
    if (linksChanged || s.design.scene.joints !== prev.design.scene.joints || s.jointValues !== prev.jointValues) {
      this.updatePoses();
    }
    if (
      linksChanged ||
      s.selection !== prev.selection ||
      s.hover !== prev.hover ||
      s.design !== prev.design ||
      s.componentWarnings !== prev.componentWarnings ||
      s.selectedMeshes !== prev.selectedMeshes
    ) {
      this.updateHighlight();
    }
    if (linksChanged || s.selection !== prev.selection || s.design.scene.joints !== prev.design.scene.joints) {
      this.updateJointArrow(s.design);
    }
  };

  private rebuildMeshes(): void {
    for (const g of this.linkGroups.values()) this.modelRoot.remove(g);
    for (const m of this.meshObjects.values()) this.disposeMesh(m);
    this.linkGroups.clear();
    this.meshObjects.clear();
    if (this.jointArrow) {
      this.jointArrow.removeFromParent();
      this.jointArrow.dispose();
      this.jointArrow = null;
    }

    const { design, viewEdges } = useApp.getState();
    let tris = 0;
    for (const link of design.scene.links) for (const ref of link.meshes) tris += registry.get(ref.id)?.triCount ?? 0;
    this.detail = tris <= DETAIL_TRIANGLE_BUDGET;
    if (useApp.getState().edgesSkipped !== !this.detail) useApp.setState({ edgesSkipped: !this.detail });
    for (const link of design.scene.links) {
      const group = new Group();
      group.name = link.id;
      group.matrixAutoUpdate = false;
      group.userData.linkId = link.id;
      for (const ref of link.meshes) {
        const entry = registry.get(ref.id);
        if (!entry) continue;
        const material = new MeshStandardMaterial({
          color: new Color().setRGB(...entry.color),
          roughness: 0.62,
          metalness: 0.05,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        });
        const mesh = new Mesh(entry.geometry, material);
        mesh.name = ref.id;
        mesh.userData.meshId = ref.id;
        mesh.userData.linkId = link.id;
        mesh.matrixAutoUpdate = false;
        // Imported geometry stays as imported; its place in the link is the pose.
        meshPoseMatrix(ref, mesh.matrix);
        mesh.visible = !useApp.getState().hiddenMeshes[ref.id];
        mesh.castShadow = this.detail;
        if (this.detail && viewEdges) this.addEdges(mesh);
        group.add(mesh);
        this.meshObjects.set(ref.id, mesh);
      }
      this.modelRoot.add(group);
      this.linkGroups.set(link.id, group);
    }
    this.requestRender();
  }

  /** A model mesh's own GPU resources: its material and its edge lines (the geometry belongs to the registry). */
  private disposeMesh(m: Mesh): void {
    (m.material as MeshStandardMaterial).dispose();
    const edges = m.userData.edges as LineSegments | undefined;
    if (edges) {
      edges.geometry.dispose();
      edges.removeFromParent();
      m.userData.edges = undefined;
    }
  }

  /** CAD-style feature edges on a model mesh (a child, so it follows the mesh's pose and visibility). */
  private addEdges(mesh: Mesh): void {
    if (mesh.userData.edges) return;
    const lines = new LineSegments(new EdgesGeometry(mesh.geometry, EDGE_ANGLE_DEG), this.edgeMaterial);
    lines.raycast = () => {};
    lines.matrixAutoUpdate = false;
    lines.userData.edges = true;
    mesh.add(lines);
    mesh.userData.edges = lines;
  }

  /** Show or hide the edges (built the first time they are shown). */
  private setEdges(on: boolean): void {
    for (const mesh of this.meshObjects.values()) {
      if (on && this.detail) this.addEdges(mesh);
      const lines = mesh.userData.edges as LineSegments | undefined;
      if (lines) lines.visible = on && this.detail;
    }
    this.requestRender();
  }

  /** Redraw the shadow with the next frame (after the model, a pose or a part changed). */
  private refreshShadow(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  private updatePoses(): void {
    const { design, jointValues } = useApp.getState();
    const poses = computeLinkPoses(design.scene, jointValues);
    for (const [id, group] of this.linkGroups) {
      const m = poses.get(id);
      group.visible = m !== undefined;
      if (m) group.matrix.copy(m);
      group.matrixWorldNeedsUpdate = true;
    }
    for (const [id, mesh] of this.meshObjects) {
      const ref = meshPlacements(design).get(id)?.ref;
      if (ref) meshPoseMatrix(ref, mesh.matrix);
      mesh.matrixWorldNeedsUpdate = true;
    }
    this.zones.restorePoses(design);
    this.components.restorePoses();
    this.wires.updatePose(design, jointValues);
    this.modelRoot.updateMatrixWorld(true);
    this.applyDraftPreview(design, poses);
    this.pickables = [...this.meshObjects.values()].filter((m) => m.parent?.visible && m.visible);
    this.tool?.onPoseChanged?.(this.ctx());
    this.refreshShadow();
    this.requestRender();
  }

  /**
   * Joint editor trial: move the would-be child (its meshes, and the subtrees
   * of joints that go with it) about the proposed axis. Render only.
   */
  private applyDraftPreview(design: Design, poses: Map<string, Matrix4>): void {
    const draft = useApp.getState().jointDraft;
    const r = this.modelSphere.radius;
    // The draft axis is in the parent link's frame: show it at the parent's current pose.
    const parentNow = draft ? poses.get(draft.parent) : undefined;
    const pw = draft?.axis && parentNow ? new Vector3(...draft.axis.point).applyMatrix4(parentNow) : null;
    const dw = draft?.axis && parentNow ? new Vector3(...draft.axis.dir).transformDirection(parentNow) : null;
    this.axisGizmo.show(pw ? pw.toArray() : null, dw ? dw.toArray() : null, r * 1.1);
    if (!draft || draft.mode !== 'new' || !pw || !dw || draft.preview === 0 || draft.type === 'fixed') return;
    const p = pw;
    const d = dw.clone().normalize();
    const delta =
      draft.type === 'prismatic'
        ? new Matrix4().makeTranslation(d.x * draft.preview, d.y * draft.preview, d.z * draft.preview)
        : new Matrix4()
            .makeTranslation(p.x, p.y, p.z)
            .multiply(new Matrix4().makeRotationAxis(d, (draft.preview * Math.PI) / 180))
            .multiply(new Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    const parentGroup = this.linkGroups.get(draft.parent);
    if (parentGroup) {
      const toParent = new Matrix4().copy(parentGroup.matrixWorld).invert();
      for (const id of draft.meshes) {
        const mesh = this.meshObjects.get(id);
        if (!mesh || mesh.parent !== parentGroup) continue;
        // mesh.matrix = parent^-1 * delta * meshWorld
        mesh.matrix.copy(toParent).multiply(delta).multiply(mesh.matrixWorld);
        mesh.matrixWorldNeedsUpdate = true;
      }
      // Zone overlays on those meshes, and the placed parts going along, move too.
      const moving = [...this.zones.overlaysOn(new Set(draft.meshes)), ...draft.components.map((id) => this.components.holder(id))];
      for (const obj of moving) {
        if (!obj || obj.parent !== parentGroup) continue;
        obj.matrix.copy(toParent).multiply(delta).multiply(obj.matrixWorld);
        obj.matrixWorldNeedsUpdate = true;
      }
    }
    for (const jointId of draft.takeJoints) {
      const joint = design.scene.joints.find((j) => j.id === jointId);
      if (!joint) continue;
      for (const linkId of subtreeLinks(design.scene, joint.child)) {
        const g = this.linkGroups.get(linkId);
        const m = poses.get(linkId);
        if (!g || !m) continue;
        g.matrix.copy(delta).multiply(m);
        g.matrixWorldNeedsUpdate = true;
      }
    }
    this.modelRoot.updateMatrixWorld(true);
  }

  /** Projected bounding-box corners of every visible mesh, in canvas pixels (for rectangle selection). */
  projectedMeshBoxes(): Array<{ id: string; corners: Array<[number, number] | null> }> {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const out: Array<{ id: string; corners: Array<[number, number] | null> }> = [];
    const v = new Vector3();
    const view = this.camera.matrixWorldInverse;
    for (const [id, mesh] of this.meshObjects) {
      if (!mesh.visible || !mesh.parent?.visible) continue;
      const bb = mesh.geometry.boundingBox;
      if (!bb) continue;
      const corners: Array<[number, number] | null> = [];
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(mesh.matrixWorld);
        const inView = v.clone().applyMatrix4(view);
        if (inView.z >= -this.camera.near) {
          corners.push(null);
          continue;
        }
        v.project(this.camera);
        corners.push([((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height]);
      }
      out.push({ id, corners });
    }
    return out;
  }

  private updateJointArrow(design: Design): void {
    const sel = useApp.getState().selection;
    if (this.jointArrow) {
      this.jointArrow.removeFromParent();
      this.jointArrow.dispose();
      this.jointArrow = null;
    }
    if (sel?.kind !== 'joint') return;
    const joint = design.scene.joints.find((j) => j.id === sel.id);
    const group = joint && this.linkGroups.get(joint.child);
    if (!joint || !group) return;
    const len = Math.max(this.modelSphere.radius * 0.35, 1);
    const axis = new Vector3(...joint.axis);
    if (axis.lengthSq() === 0) return;
    this.jointArrow = new ArrowHelper(axis.normalize(), new Vector3(), len, 0xe0a020, len * 0.18, len * 0.08);
    this.jointArrow.traverse((o) => {
      const mat = (o as Mesh).material as MeshStandardMaterial | undefined;
      if (mat) mat.depthTest = false;
      o.renderOrder = 10;
    });
    group.add(this.jointArrow);
    this.jointArrow.updateMatrixWorld(true);
  }

  private updateHighlight(): void {
    const { selection, hover, design } = useApp.getState();
    const selected = new Set<string>();
    if (selection?.kind === 'mesh') selected.add(selection.id);
    else if (selection?.kind === 'link' || selection?.kind === 'joint') {
      const linkId = selection.kind === 'link' ? selection.id : design.scene.joints.find((j) => j.id === selection.id)?.child;
      const group = linkId ? this.linkGroups.get(linkId) : undefined;
      group?.children.forEach((c) => c.userData.meshId && selected.add(c.userData.meshId as string));
    }
    for (const id of useApp.getState().selectedMeshes) selected.add(id);
    const selColor = this.theme.dark ? SELECT_EMISSIVE_DARK : SELECT_EMISSIVE;
    for (const [id, mesh] of this.meshObjects) {
      const mat = mesh.material as MeshStandardMaterial;
      if (selected.has(id)) mat.emissive.copy(selColor);
      else if (hover?.meshId === id && !this.hoverComponent) mat.emissive.copy(HOVER_EMISSIVE);
      else mat.emissive.setRGB(0, 0, 0);
    }
    this.components.highlight(
      selection?.kind === 'component' ? selection.id : null,
      this.hoverComponent,
      useApp.getState().componentWarnings,
    );
    this.requestRender();
  }

  // ------------------------------------------------------------ queries

  /** Pick a placed component (body or port marker) along a ray. */
  pickComponent(ray: Ray): ComponentHit | null {
    this.raycaster.ray.copy(ray);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = false;
    return this.components.pick(this.raycaster);
  }

  /** Where the ray meets the real surface of a placed component of `partId` (part frame), for Add port. */
  pickPartSurface(ray: Ray, partId: string) {
    this.raycaster.ray.copy(ray);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = false;
    return this.components.pickSurface(this.raycaster, partId);
  }

  /** A point handle of the selected wire under the ray. */
  pickWireHandle(ray: Ray): { cableId: string; index: number; distance: number } | null {
    this.raycaster.ray.copy(ray);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    return this.wires.pickHandle(this.raycaster);
  }

  /** A wire under the ray. */
  pickWire(ray: Ray): { cableId: string; distance: number } | null {
    this.raycaster.ray.copy(ray);
    this.raycaster.near = 0;
    this.raycaster.far = Infinity;
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = false;
    return this.wires.pickWire(this.raycaster);
  }

  setHoverComponent(id: string | null): void {
    if (this.hoverComponent === id) return;
    this.hoverComponent = id;
    this.updateHighlight();
  }

  /** World pose of a link as currently shown (joint preview applied). */
  linkWorldMatrix(linkId: string): Matrix4 | undefined {
    const g = this.linkGroups.get(linkId);
    if (!g || !g.visible) return undefined;
    g.updateWorldMatrix(true, false);
    return g.matrixWorld.clone();
  }

  /** Redraw zone overlays now (after changing the zone draft). */
  refreshZones(): void {
    const s = useApp.getState();
    this.zones.sync(s.design, s.hiddenZones, s.selection?.kind === 'zone' ? s.selection.id : null);
    this.requestRender();
  }

  /** Redraw components now (after changing the component draft). */
  refreshComponents(): void {
    const s = useApp.getState();
    this.components.sync(s.design, s.library);
    this.requestRender();
  }

  /** Camera position in world space. */
  eye(): Vector3 {
    return this.camera.position.clone();
  }

  linkObject(linkId: string): Group | undefined {
    return this.linkGroups.get(linkId);
  }

  meshObject(meshId: string): Mesh | undefined {
    return this.meshObjects.get(meshId);
  }

  /** Normalised device coordinates for a client-space point. */
  toNdc(clientX: number, clientY: number, out = new Vector2()): Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return out.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  /** Ray under a client-space point. */
  rayAt(clientX: number, clientY: number): Ray {
    this.raycaster.setFromCamera(this.toNdc(clientX, clientY), this.camera);
    return this.raycaster.ray.clone();
  }

  /** First mesh hit under a client-space point, or null. Uses the BVHs. */
  pick(clientX: number, clientY: number): RayHit | null {
    this.raycaster.setFromCamera(this.toNdc(clientX, clientY), this.camera);
    return this.pickRay(this.raycaster.ray);
  }

  pickRay(ray: Ray): RayHit | null {
    this.raycaster.ray.copy(ray);
    this.raycaster.near = this.camera.near;
    this.raycaster.far = Infinity;
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
    const ready = this.pickables.filter((m) => registry.get(m.userData.meshId as string)?.bvhReady);
    const hits = this.raycaster.intersectObjects(ready, false);
    const hit = hits[0];
    return hit ? this.toRayHit(hit) : null;
  }

  private toRayHit(hit: Intersection): RayHit | null {
    const mesh = hit.object as Mesh;
    const meshId = mesh.userData.meshId as string;
    const linkId = mesh.userData.linkId as string;
    const group = this.linkGroups.get(linkId);
    if (!group) return null;
    // The mesh may sit in its link at a pose (regrouped CAD bodies).
    const r = resolveHit(hit, mesh.matrixWorld, group.matrixWorld);
    return r ? { meshId, linkId, ...r } : null;
  }

  // ------------------------------------------------------------ camera

  /** World bounding box of the whole model, or of the selected mesh/link. */
  bounds(which: 'all' | 'selection'): Box3 {
    const box = new Box3();
    const { selection, design } = useApp.getState();
    let meshes: Mesh[] = [...this.meshObjects.values()];
    if (which === 'selection' && selection?.kind === 'component') {
      const c = design.components.find((x) => x.id === selection.id);
      const part = c && useApp.getState().library?.parts.find((p) => p.id === c.part);
      const world = c && this.components.worldMatrix(c.id);
      if (part && world) {
        const [sx, sy, sz] = part.body.size_mm;
        return new Box3(new Vector3(-sx / 2, -sy / 2, 0), new Vector3(sx / 2, sy / 2, sz)).applyMatrix4(world);
      }
      return box;
    }
    if (which === 'selection' && selection) {
      if (selection.kind === 'mesh') meshes = meshes.filter((m) => m.userData.meshId === selection.id);
      else if (selection.kind === 'zone') {
        const zone = design.zones.find((z) => z.id === selection.id);
        meshes = meshes.filter((m) => m.userData.meshId === zone?.mesh);
      }
      else {
        const linkId =
          selection.kind === 'link' ? selection.id : design.scene.joints.find((j) => j.id === selection.id)?.child;
        meshes = meshes.filter((m) => m.userData.linkId === linkId);
      }
    }
    const tmp = new Box3();
    for (const m of meshes) {
      if (!m.parent?.visible || !m.geometry.boundingBox) continue;
      tmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
      box.union(tmp);
    }
    return box;
  }

  /** Frame the model (or the selection, falling back to the model). */
  fit(which: 'all' | 'selection' = 'all'): void {
    let box = this.bounds(which);
    if (box.isEmpty()) box = this.bounds('all');
    if (box.isEmpty()) box = new Box3(new Vector3(-250, -250, 0), new Vector3(250, 250, 250));
    const sphere = box.getBoundingSphere(new Sphere());
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-12) dir.copy(VIEW_DIRS.iso);
    dir.normalize();
    // Fit the box's corners, not its bounding sphere: the model fills the view (with a small margin).
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanH = tanV * this.camera.aspect;
    const right = new Vector3().crossVectors(this.camera.up, dir).normalize();
    if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
    const up = new Vector3().crossVectors(dir, right).normalize();
    let dist = 1;
    const c = new Vector3();
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(sphere.center);
      const along = c.dot(dir);
      dist = Math.max(dist, Math.abs(c.dot(right)) / tanH + along, Math.abs(c.dot(up)) / tanV + along);
    }
    dist *= 1.06;
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.lookAt(sphere.center);
    this.controls.update();
    this.requestRender();
  }

  setView(view: StandardView): void {
    const dist = Math.max(this.camera.position.distanceTo(this.controls.target), 1);
    const dir = VIEW_DIRS[view].clone().normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.fit(useApp.getState().selection ? 'selection' : 'all');
  }

  /** Call after a new model is loaded: resize the grid and frame the model. */
  onModelLoaded(): void {
    const box = this.bounds('all');
    if (!box.isEmpty()) {
      box.getBoundingSphere(this.modelSphere);
      const size = box.getSize(new Vector3());
      this.grid.setSize(Math.max(size.x, size.y, size.z));
      this.grid.position.z = box.min.z < -1e-3 * size.z ? box.min.z : 0;
      // The ground under the model, and a shadow camera that just covers it.
      const r = this.modelSphere.radius;
      const c = this.modelSphere.center;
      this.ground.scale.set(r * 6, r * 6, 1);
      this.ground.position.set(c.x, c.y, this.grid.position.z - r * 1e-4);
      this.sun.target.position.copy(c);
      this.sun.position.set(c.x + r * 0.7, c.y - r * 0.9, c.z + r * 2);
      const cam = this.sun.shadow.camera;
      cam.left = cam.bottom = -r * 1.6;
      cam.right = cam.top = r * 1.6;
      cam.near = r * 0.1;
      cam.far = r * 5;
      cam.updateProjectionMatrix();
      this.sun.target.updateMatrixWorld();
      this.ground.visible = this.detail;
      this.refreshShadow();
    }
    this.camera.position.copy(this.controls.target).add(VIEW_DIRS.iso);
    this.fit('all');
  }

  // ------------------------------------------------------------ tools and pointer

  setTool(tool: Tool | null): void {
    if (this.tool === tool) return;
    this.tool?.deactivate?.(this.ctx());
    this.tool = tool;
    this.renderer.domElement.style.cursor = tool?.cursor ?? '';
    tool?.activate?.(this.ctx());
    this.requestRender();
  }

  getTool(): Tool | null {
    return this.tool;
  }

  /** Forward a key to the active tool. Returns true if it handled the key. */
  handleKey(e: KeyboardEvent): boolean {
    return Boolean(this.tool?.onKeyDown?.(e, this.ctx()));
  }

  private toolEvent(native: PointerEvent | MouseEvent): ToolPointerEvent {
    const ndc = this.toNdc(native.clientX, native.clientY);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray.clone();
    let cached: RayHit | null | undefined;
    const pick = () => {
      if (cached === undefined) cached = this.pickRay(ray);
      return cached;
    };
    return {
      native,
      ndc,
      ray,
      get hit() {
        return pick();
      },
    };
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.renderer.domElement.focus({ preventScroll: true });
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
    if (this.tool?.onPointerDown && e.button === 0) {
      const capture = this.tool.onPointerDown(this.toolEvent(e), this.ctx());
      if (capture) {
        this.captured = true;
        this.controls.enabled = false;
        this.renderer.domElement.setPointerCapture(e.pointerId);
        e.stopImmediatePropagation();
      }
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.captured) {
      this.tool?.onPointerMove?.(this.toolEvent(e), this.ctx());
      return;
    }
    if (e.buttons !== 0) {
      // Camera drag in progress: no hover picking.
      if (useApp.getState().hover) useApp.getState().setHover(null);
      return;
    }
    // Coalesce hover picks to one per frame.
    this.pendingMove = e;
    if (!this.frameRequested) {
      this.frameRequested = true;
      requestAnimationFrame(this.frame);
    }
  };

  private dispatchMove(e: PointerEvent): void {
    this.tool?.onPointerMove?.(this.toolEvent(e), this.ctx());
  }

  private onPointerUp = (e: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    const ev = this.toolEvent(e);
    if (this.captured) {
      // Clear the flag first: releasing capture fires lostpointercapture.
      this.captured = false;
      this.controls.enabled = true;
      if (this.renderer.domElement.hasPointerCapture?.(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
      this.tool?.onPointerUp?.(ev, this.ctx());
      return;
    }
    this.tool?.onPointerUp?.(ev, this.ctx());
    if (down && down.button === 0 && e.button === 0 && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= CLICK_SLOP_PX) {
      this.tool?.onClick?.(ev, this.ctx());
    }
  };

  /** The pointer went away mid-gesture (cancel, capture lost): end it and give the camera back. */
  private onPointerCancel = (e: PointerEvent): void => {
    this.down = null;
    if (!this.captured) return;
    this.captured = false;
    this.controls.enabled = true;
    const tool = this.tool;
    if (tool?.onPointerCancel) tool.onPointerCancel(this.ctx());
    else tool?.onPointerUp?.(this.toolEvent(e), this.ctx());
  };

  private onDoubleClick = (e: MouseEvent): void => {
    this.tool?.onDoubleClick?.(this.toolEvent(e), this.ctx());
  };

  private onPointerLeave = (): void => {
    this.pendingMove = null;
    if (!this.captured) this.tool?.onPointerLeave?.(this.ctx());
  };
}
