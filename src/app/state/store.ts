/**
 * App state. The design is the single source of truth and is kept as
 * immutable data: every change goes through `commit`, which pushes the
 * previous design onto the undo stack. Geometry never lives here; see
 * `scene/registry.ts`.
 *
 * Joint values being previewed (`jointValues`) are view state, not part of
 * the design, until `savePose` writes them to `joint.value`.
 */
import { create } from 'zustand';
import type { SuggestionState } from '../joints/suggestions';
import type { CableSettings, RoutePoint } from '../wires/routeEdit';
import type { WireStatus } from '../wires/run';
import { normalizeDesign } from './designOps';
import { syncDesignCableTypes, syncDesignParts } from './designParts';
import type { StoredCable } from '../parts/store';
import { pruneDanglingPortRefs } from './portRefs';
import { followWireEnds } from '../wires/follow';
import { clampJointValue, emptyDesign, mergeLibrary, savedJointValues, type CableLibrary, type ConnectorLibrary, type Design, type PortRef, type JointType, type Library, type Part, type ZoneKind } from '@core';

export type SelectionKind = 'link' | 'mesh' | 'joint' | 'zone' | 'component' | 'cable';
export type Selection = { kind: SelectionKind; id: string } | null;

/**
 * A joint axis being edited, in the PARENT link's frame (independent of
 * preview joint values). Converted to world only for display and the gizmo.
 */
export interface AxisDraft {
  point: [number, number, number];
  dir: [number, number, number];
  /** How it was obtained, when picked on the model. */
  fit?: {
    kind: 'cylinder' | 'flat';
    radius: number;
    rmsRelative: number;
    maxNormalDot: number;
    quality: 'good' | 'poor';
    /** 'guess' when only the direction is known (a flat face that is not round). */
    position: 'determined' | 'guess';
    /** Set when the axis was adopted from a suggestion: its description. */
    suggested?: string;
    note?: string;
    meshId: string;
  };
}

/** The joint editor's working state (view state until Create / Apply). */
export interface JointDraft {
  mode: 'new' | 'edit';
  /** Edit mode: the joint being edited. */
  jointId?: string;
  /** Edit mode: a fixed joint becoming movable with this type (needs an axis). */
  retype?: JointType;
  /** New mode: the link the meshes are on now (becomes the parent). */
  parent: string;
  meshes: string[];
  components: string[];
  /** Existing child joints of `parent` that move with the new link. */
  takeJoints: string[];
  name: string;
  type: JointType;
  /** Limits in display units (degrees or mm). */
  lower: number;
  upper: number;
  axis: AxisDraft | null;
  /** Trial value for the render-only preview, display units. */
  preview: number;
  /** True while the user is picking the axis on the model. */
  picking: boolean;
}

export interface ZoneToolSettings {
  kind: ZoneKind;
  /** `face`: one click floods a connected surface; `brush`: paint within a radius. */
  mode: 'face' | 'brush';
  erase: boolean;
  radiusMm: number;
  creaseDeg: number;
}

/** A port under the pointer, with its position in viewport pixels. */
export interface PortHover {
  componentId: string;
  portId: string;
  x: number;
  y: number;
}

export interface Hover {
  meshId: string;
  linkId: string;
  triangle: number;
  /** World point in mm. */
  point: [number, number, number];
}

export type NoticeLevel = 'info' | 'warning' | 'error';
export interface Notice {
  id: number;
  level: NoticeLevel;
  title: string;
  details: string[];
}

export type UnitChoice = 'mm' | 'cm' | 'm' | 'inch';

export interface UnitRequest {
  fileName: string;
  resolve: (unit: UnitChoice | null) => void;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

const HISTORY_LIMIT = 200;

export interface AppState {
  design: Design;
  past: Design[];
  future: Design[];
  /** The design as last saved or opened. `design !== savedDesign` means unsaved changes. */
  savedDesign: Design;
  /** Bumped whenever the design is replaced wholesale (new import, open project). */
  designEpoch: number;

  /** Parts lookups go here: the bundled parts with the design's own parts on top (see state/library.ts). */
  library: Library | null;
  /** The bundled parts library alone. */
  baseLibrary: Library | null;
  /** The user's own parts kept on this PC (IndexedDB), loaded at start-up. */
  customParts: Part[];
  /** Files given to "Add your own part" (the dialog takes the first). */
  pendingPartFiles: File[] | null;
  libraryError: string | null;
  /** Connector families, bundled from library/connectors.yaml (null until it exists). */
  connectorLibrary: ConnectorLibrary | null;
  /** Cable types, bundled from library/cables.yaml. */
  cableLibrary: CableLibrary | null;
  /** The bundled cable types alone; `cableLibrary` is these + the user's own + the design's own (state/library.ts). */
  baseCableLibrary: CableLibrary | null;
  /** The user's own cable types kept on this PC, with the parameters each was built from. */
  customCables: StoredCable[];
  /** Bumped when settled wire shapes arrive (wires/settle.ts), to redraw them. */
  shapeVersion: number;
  /** View: the ground grid shown. */
  viewGrid: boolean;
  /** View: feature edges drawn on the model. */
  viewEdges: boolean;
  /** The model is too large for edges (they are left off to keep the view fast). */
  edgesSkipped: boolean;
  /** "Add your own cable" is open: a new cable, or editing the stored one `editId`. */
  cableDialog: { editId?: string } | null;

  /** Previewed joint values by joint id (radians or mm). */
  jointValues: Record<string, number>;
  selection: Selection;
  /** Mesh multi-selection (ordered). A single mesh selection is also `selection`. */
  selectedMeshes: string[];
  /** Anchor for Shift+click range selection in the tree. */
  meshAnchor: string | null;
  /** Meshes hidden in the viewport (view state). */
  hiddenMeshes: Record<string, true>;
  jointDraft: JointDraft | null;
  /** Suggested axes for the open joint draft. */
  axisSuggestions: SuggestionState | null;
  /** A suggested axis under the pointer in the list (previewed in the viewport). */
  axisHover: { point: [number, number, number]; dir: [number, number, number] } | null;
  /** Rectangle selection in progress, viewport pixels. */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  hover: Hover | null;

  /** Bumped when the geometry registry changes. */
  geometryVersion: number;
  triangleCount: number;
  /** Meshes whose BVH is still being built. */
  bvhPending: number;

  progress: { fraction: number; label: string } | null;
  notices: Notice[];
  confirm: ConfirmRequest | null;
  /** Pending question: what length unit a unitless file (STL, OBJ) uses. */
  unitRequest: UnitRequest | null;
  activeTool: string;
  /** Settings for the next wire drawn. */
  wireSettings: CableSettings;
  /** A wire being drawn (points so far and the point under the cursor). */
  /** The wire being drawn. `marks`: where each click's points start (draped points follow a click). */
  /** `markPorts`: per click, the port it snapped to (first and last attach the route's ends). */
  wireDraft: { points: RoutePoint[]; cursor: RoutePoint | null; marks?: number[]; markPorts?: Array<PortRef | null>; settled?: number } | null;
  /** Results of the wire checks at the pose shown, per cable id. */
  wireChecks: Record<string, WireStatus>;
  /** Per-end allowance for stripping and termination, mm. */
  wireAllowance_mm: number;
  /** Per wire: legs draped point by point (no single 'up'), for the wire's notes. */
  drapeSettled: Record<string, number>;
  /** A selected point handle of the selected wire. */
  wirePoint: { cableId: string; index: number } | null;
  /** The cable whose type comparison is open. */
  compareCable: string | null;

  zoneTool: ZoneToolSettings;
  /** Zones hidden in the viewport (view state). */
  hiddenZones: Record<string, true>;
  /** Part id the Place tool is placing, or null. */
  placingPart: string | null;
  /** The part whose details are shown (chosen in the Parts tab, placed or not). */
  partDetails: string | null;
  /** The custom part whose ports are open in the port editor: its placed components show connector boxes. */
  editingPart: string | null;
  /** The part the Add port tool is picking a point on. */
  portPickPart: string | null;
  /** The port the port editor should open (just added). */
  portEditFocus: string | null;
  /** Rotation about the surface normal for the next placement, radians. */
  placeSpin: number;
  /** What would be wrong with the part where the placing preview is (shown in the placing bar); empty when fine. */
  placeWarnings: string[];
  portHover: PortHover | null;
  /** Non-blocking warnings per component id (collisions, outside zone). */
  componentWarnings: Record<string, string[]>;

  // ---- design changes (undoable)
  commit: (recipe: (d: Design) => Design) => void;
  undo: () => void;
  redo: () => void;
  /** Replace the design and clear history (new import or opened project). */
  replaceDesign: (design: Design, opts?: { saved?: boolean }) => void;
  markSaved: () => void;

  // ---- view state
  setJointValue: (jointId: string, value: number) => void;
  zeroPose: () => void;
  resetPoseToSaved: () => void;
  savePose: () => void;
  select: (sel: Selection) => void;
  /** Replace the mesh multi-selection. */
  selectMeshes: (ids: string[], anchor?: string | null) => void;
  setHiddenMeshes: (hidden: Record<string, true>) => void;
  setJointDraft: (draft: JointDraft | null | ((d: JointDraft) => JointDraft)) => void;
  setHover: (hover: Hover | null) => void;
  setProgress: (p: { fraction: number; label: string } | null) => void;
  notify: (level: NoticeLevel, title: string, details?: string[]) => void;
  dismissNotice: (id: number) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string) => Promise<boolean>;
  /** Ask which unit a unitless model file is in. Resolves null if cancelled. */
  askUnit: (fileName: string) => Promise<UnitChoice | null>;
  setActiveTool: (id: string) => void;
  setZoneTool: (patch: Partial<ZoneToolSettings>) => void;
  toggleZoneHidden: (id: string) => void;
  /** Arm the Place tool with a part, or disarm it with null. */
  startPlacing: (partId: string | null) => void;
}

/** A remembered view toggle (on unless turned off before). */
function viewPref(name: 'grid' | 'edges'): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(`wiring-design.view.${name}`) !== 'off';
  } catch {
    return true;
  }
}

let noticeSeq = 1;
const initialDesign = emptyDesign();

export const useApp = create<AppState>()((set, get) => ({
  design: initialDesign,
  past: [],
  future: [],
  savedDesign: initialDesign,
  designEpoch: 0,
  library: null,
  baseLibrary: null,
  customParts: [],
  pendingPartFiles: null,
  libraryError: null,
  connectorLibrary: null,
  cableLibrary: null,
  baseCableLibrary: null,
  customCables: [],
  cableDialog: null,
  shapeVersion: 0,
  viewGrid: viewPref('grid'),
  viewEdges: viewPref('edges'),
  edgesSkipped: false,
  jointValues: {},
  selection: null,
  selectedMeshes: [],
  meshAnchor: null,
  hiddenMeshes: {},
  jointDraft: null,
  axisSuggestions: null,
  axisHover: null,
  marquee: null,
  hover: null,
  geometryVersion: 0,
  triangleCount: 0,
  bvhPending: 0,
  progress: null,
  notices: [],
  confirm: null,
  unitRequest: null,
  activeTool: 'select',
  wireSettings: { type: '', count: 1, twisted: false, sleeve_wall_mm: 0, drape: true },
  wireDraft: null,
  wireChecks: {},
  wireAllowance_mm: 10,
  drapeSettled: {},
  wirePoint: null,
  compareCable: null,
  zoneTool: { kind: 'mount_allowed', mode: 'face', erase: false, radiusMm: 8, creaseDeg: 20 },
  hiddenZones: {},
  partDetails: null,
  editingPart: null,
  portPickPart: null,
  portEditFocus: null,
  placingPart: null,
  placeSpin: 0,
  placeWarnings: [],
  portHover: null,
  componentWarnings: {},

  commit: (recipe) => {
    const prev = get().design;
    const st = get();
    let next = normalizeDesign(recipe(prev));
    // A custom part placed travels with the design; its definition leaves with its last component.
    next = syncDesignParts(next, st.library);
    // Likewise the user's own cable types its wires use.
    next = syncDesignCableTypes(next, st.cableLibrary);
    // Wire ends attached to ports follow their component (moved, turned, port edited).
    let detachedWires: string[] = [];
    if (next.components !== prev.components || next.parts !== prev.parts || next.routes !== prev.routes || next.connections !== prev.connections) {
      const library = st.library ? mergeLibrary(st.library, next.parts) : null;
      next = followWireEnds(next, { library, connectors: st.connectorLibrary, cables: st.cableLibrary });
      // References to ports that are gone (a deleted port) are detached in the same undo step, so the design stays saveable.
      ({ design: next, detachedWires } = pruneDanglingPortRefs(next, library));
    }
    if (next === prev) return;
    if (detachedWires.length)
      st.notify('info', `Detached ${detachedWires.length === 1 ? 'a wire end' : 'wire ends'} from a port that is gone`, [
        `${detachedWires.join(', ')}: the end stays where it was, no longer attached. Undo brings the port back.`,
      ]);
    set((s) => ({ design: next, past: [...s.past, prev].slice(-HISTORY_LIMIT), future: [], ...viewStateFor(s, prev, next) }));
  },
  undo: () => {
    const { past, design, future } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set((s) => ({ design: prev, past: past.slice(0, -1), future: [design, ...future], ...viewStateFor(s, design, prev), wirePoint: null }));
  },
  redo: () => {
    const { past, design, future } = get();
    const next = future[0];
    if (!next) return;
    set((s) => ({ design: next, past: [...past, design], future: future.slice(1), ...viewStateFor(s, design, next), wirePoint: null }));
  },
  replaceDesign: (design, opts = {}) =>
    set((s) => ({
      design,
      past: [],
      future: [],
      savedDesign: opts.saved === false ? s.savedDesign : design,
      designEpoch: s.designEpoch + 1,
      jointValues: savedJointValues(design.scene),
      selection: null,
      selectedMeshes: [],
      meshAnchor: null,
      hiddenMeshes: {},
      jointDraft: null,
      wireDraft: null,
      wireChecks: {},
      wirePoint: null,
      compareCable: null,
      partDetails: null,
      placingPart: null,
      hover: null,
      hiddenZones: {},
      componentWarnings: {},
      portHover: null,
    })),
  markSaved: () => set((s) => ({ savedDesign: s.design })),

  setJointValue: (jointId, value) => {
    const joint = get().design.scene.joints.find((j) => j.id === jointId);
    if (!joint) return;
    set((s) => ({ jointValues: { ...s.jointValues, [jointId]: clampJointValue(joint, value) } }));
  },
  zeroPose: () => {
    const values: Record<string, number> = {};
    for (const j of get().design.scene.joints) values[j.id] = clampJointValue(j, 0);
    set({ jointValues: values });
  },
  resetPoseToSaved: () => set((s) => ({ jointValues: savedJointValues(s.design.scene) })),
  savePose: () => {
    const values = get().jointValues;
    get().commit((d) => {
      let changed = false;
      const joints = d.scene.joints.map((j) => {
        const v = values[j.id];
        if (v === undefined || j.type === 'fixed') return j;
        const clamped = clampJointValue(j, v);
        if (clamped === j.value) return j;
        changed = true;
        return { ...j, value: clamped };
      });
      return changed ? { ...d, scene: { ...d.scene, joints } } : d;
    });
  },
  select: (selection) =>
    set((s) => ({
      selection,
      // A selected wire point belongs to the wire it was picked on: another selection drops it.
      wirePoint: selection?.kind === 'cable' && s.wirePoint?.cableId === selection.id ? s.wirePoint : null,
      selectedMeshes: selection?.kind === 'mesh' ? [selection.id] : [],
      meshAnchor: selection?.kind === 'mesh' ? selection.id : null,
    })),
  selectMeshes: (ids, anchor) =>
    set((s) => {
      const last = ids[ids.length - 1];
      return {
        selectedMeshes: ids,
        meshAnchor: anchor === undefined ? s.meshAnchor : anchor,
        selection: last ? { kind: 'mesh', id: last } : null,
      };
    }),
  setHiddenMeshes: (hiddenMeshes) => set({ hiddenMeshes }),
  setJointDraft: (draft) =>
    set((s) => ({ jointDraft: typeof draft === 'function' ? (s.jointDraft ? draft(s.jointDraft) : null) : draft })),
  setHover: (hover) => {
    const cur = get().hover;
    if (cur === hover) return;
    if (cur && hover && cur.meshId === hover.meshId && cur.triangle === hover.triangle) return;
    set({ hover });
  },
  setProgress: (progress) => set({ progress }),
  notify: (level, title, details = []) =>
    set((s) => ({ notices: [...s.notices, { id: noticeSeq++, level, title, details }] })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  askConfirm: (title, message, confirmLabel = 'Continue') =>
    new Promise<boolean>((resolve) => {
      get().confirm?.resolve(false);
      set({
        confirm: {
          title,
          message,
          confirmLabel,
          resolve: (ok) => {
            set({ confirm: null });
            resolve(ok);
          },
        },
      });
    }),
  askUnit: (fileName) =>
    new Promise<UnitChoice | null>((resolve) => {
      get().unitRequest?.resolve(null);
      set({
        unitRequest: {
          fileName,
          resolve: (unit) => {
            set({ unitRequest: null });
            resolve(unit);
          },
        },
      });
    }),
  setActiveTool: (activeTool) => set((s) => ({ activeTool, placingPart: activeTool === 'place' ? s.placingPart : null })),
  setZoneTool: (patch) => set((s) => ({ zoneTool: { ...s.zoneTool, ...patch } })),
  toggleZoneHidden: (id) =>
    set((s) => {
      const hiddenZones = { ...s.hiddenZones };
      if (hiddenZones[id]) delete hiddenZones[id];
      else hiddenZones[id] = true;
      return { hiddenZones };
    }),
  startPlacing: (partId) => set({ placingPart: partId, activeTool: partId ? 'place' : 'select' }),
}));

/**
 * View state after the design changes from `from` to `to` (edit, undo or
 * redo). Anything keyed by an id that no longer exists is dropped, so a later
 * item that reuses the id starts clean. Previewed joint values are kept,
 * except for joints whose saved value changed (a pose save being made or
 * undone), which follow the saved value.
 */
function viewStateFor(s: AppState, from: Design, to: Design): Partial<AppState> {
  const out: Partial<AppState> = {};
  if (to.scene.joints !== from.scene.joints) {
    const before = new Map(from.scene.joints.map((j) => [j.id, j]));
    const jointValues: Record<string, number> = {};
    for (const j of to.scene.joints) {
      const oldJoint = before.get(j.id);
      const old = oldJoint?.value;
      const preview = s.jointValues[j.id];
      // An axis flip (made, undone or redone) reverses the sign convention: the
      // same pose has the opposite value, so the preview is negated, not reset.
      const flipped =
        oldJoint !== undefined &&
        j.axis.every((v, k) => v === 0 - oldJoint.axis[k]!) &&
        j.axis.some((v) => v !== 0) &&
        (j.limit && oldJoint.limit ? j.limit.lower === 0 - oldJoint.limit.upper && j.limit.upper === 0 - oldJoint.limit.lower : !j.limit && !oldJoint.limit);
      if (flipped && preview !== undefined) jointValues[j.id] = 0 - preview;
      else jointValues[j.id] = old === undefined || old !== j.value || preview === undefined ? j.value : preview;
    }
    out.jointValues = jointValues;
  }
  if (to.zones !== from.zones) {
    const ids = new Set(to.zones.map((z) => z.id));
    const hidden: Record<string, true> = {};
    for (const id of Object.keys(s.hiddenZones)) if (ids.has(id)) hidden[id] = true;
    out.hiddenZones = hidden;
  }
  if (to.components !== from.components) {
    const ids = new Set(to.components.map((c) => c.id));
    const warnings: Record<string, string[]> = {};
    for (const [id, w] of Object.entries(s.componentWarnings)) if (ids.has(id)) warnings[id] = w;
    out.componentWarnings = warnings;
    if (s.portHover && !ids.has(s.portHover.componentId)) out.portHover = null;
  }
  if (to.cables !== from.cables) {
    const ids = new Set(to.cables.map((c) => c.id));
    const checks: Record<string, WireStatus> = {};
    for (const [id, w] of Object.entries(s.wireChecks)) if (ids.has(id)) checks[id] = w;
    out.wireChecks = checks;
    if (s.wirePoint && !ids.has(s.wirePoint.cableId)) out.wirePoint = null;
    if (s.compareCable && !ids.has(s.compareCable)) out.compareCable = null;
  }
  out.selection = keepSelection(s.selection, to);
  if (to.scene.links !== from.scene.links) {
    const meshIds = new Set(to.scene.links.flatMap((l) => l.meshes.map((m) => m.id)));
    out.selectedMeshes = s.selectedMeshes.filter((id) => meshIds.has(id));
    const hidden: Record<string, true> = {};
    for (const id of Object.keys(s.hiddenMeshes)) if (meshIds.has(id)) hidden[id] = true;
    out.hiddenMeshes = hidden;
  }
  if (out.selection?.kind !== 'mesh' && s.selectedMeshes.length <= 1) out.selectedMeshes = [];
  if (s.hover && !to.scene.links.some((l) => l.id === s.hover!.linkId && l.meshes.some((m) => m.id === s.hover!.meshId))) out.hover = null;
  return out;
}

function keepSelection(sel: Selection, design: Design): Selection {
  if (!sel) return null;
  const { links, joints } = design.scene;
  if (sel.kind === 'link') return links.some((l) => l.id === sel.id) ? sel : null;
  if (sel.kind === 'joint') return joints.some((j) => j.id === sel.id) ? sel : null;
  if (sel.kind === 'zone') return design.zones.some((z) => z.id === sel.id) ? sel : null;
  if (sel.kind === 'component') return design.components.some((c) => c.id === sel.id) ? sel : null;
  if (sel.kind === 'cable') return design.cables.some((c) => c.id === sel.id) ? sel : null;
  return links.some((l) => l.meshes.some((m) => m.id === sel.id)) ? sel : null;
}

export const isDirty = (s: AppState) => s.design !== s.savedDesign;

/** Link that owns a mesh, from the design. */
export function linkOfMesh(design: Design, meshId: string): string | undefined {
  for (const l of design.scene.links) if (l.meshes.some((m) => m.id === meshId)) return l.id;
  return undefined;
}

/** Ask before discarding unsaved changes. Resolves true if it is fine to go on. */
export async function confirmDiscard(action: string): Promise<boolean> {
  const s = useApp.getState();
  if (!isDirty(s)) return true;
  return s.askConfirm('Unsaved changes', `${action} replaces the current design. Changes since the last save will be lost.`, 'Discard changes');
}
