/**
 * Three.js object for a library part, in the part frame (origin at the centre
 * of the mounting face, +Z away from it; envelope on z in [0, sz]).
 *
 * Three ways to draw it:
 *  (a) a model (`part.model`: bundled, or the user's own `custom:<sha>` from
 *      the parts store): the envelope box stands in until the model has
 *      loaded, then the model replaces it. If the model cannot be loaded (or a
 *      custom model is not on this PC) the part is drawn as (b) or (c), and the
 *      caller is told once.
 *  (b) no model but a board (`body.board`): the circuit board slab at its
 *      height, a housing box at every port (from the connector library), the
 *      mounting holes, and the rest of the envelope as a faint outline so its
 *      real height is visible.
 *  (c) neither: the envelope box.
 * In every case the envelope box is the pick and collision body (`body`), so
 * placement and fit checks do not depend on how the part is drawn. Ports get
 * an arrow along their +X (the way the cable leaves) and a pickable marker.
 */
import {
  ArrowHelper,
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { connectorBoxes, findConnector, portWays, type ConnectorLibrary, type Part } from '@core';
import { instanceModel, isDrawableModel, loadPartModel } from './partModels';

const CATEGORY_COLOR: Record<Part['category'], number> = {
  controller: 0x2f7d5b,
  sensor: 0x6a4fa3,
  driver: 0xa3523a,
  actuator: 0x8a6d3b,
  power: 0xb08a2a,
  camera: 0x3a424e,
  display: 0x2a5b8a,
  other: 0x6b7280,
};

export interface PartVisual {
  group: Group;
  /** The envelope: pick and collision body. Drawn as the part itself only in case (c). */
  body: Mesh;
  /** The main visible material (board or box). */
  bodyMaterial: MeshStandardMaterial;
  /** Small pickable spheres at the ports; `userData.portId` names the port. */
  portMarkers: Mesh[];
  /** Highlight every visible surface of the part. */
  setEmissive(c: Color): void;
  /** How it is drawn right now. */
  kind(): 'model' | 'board' | 'box';
  /** Settles when the model, if any, is in place (or has failed and the fallback stays). */
  ready: Promise<void>;
}

export interface PartVisualOptions {
  preview?: boolean;
  connectors?: ConnectorLibrary | null;
  /** The model arrived and replaced the placeholder (thumbnails re-render on this). */
  onModel?: () => void;
  /** Draw every port's housing (solid) and plug (see-through) box: while its ports are being edited. */
  showConnectorBoxes?: boolean;
  /** The model could not be loaded (told once per model). */
  onModelFail?: (uri: string, message: string, missing: boolean) => void;
}

export function partColor(part: Part): Color {
  return new Color(CATEGORY_COLOR[part.category] ?? CATEGORY_COLOR.other);
}

const BOARD_COLOR = 0x1f6b45;
const HOUSING_COLOR = 0xe8e4dc;

function ring(r: number): BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push(Math.cos(a) * r, Math.sin(a) * r, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pts, 3));
  return g;
}

/** Board, housings and holes (case b), in the part frame. */
function boardGroup(part: Part, connectors: ConnectorLibrary | null | undefined, mats: MeshStandardMaterial[]): Group {
  const g = new Group();
  const [sx, sy] = part.body.size_mm;
  const board = part.body.board!;
  const boardMat = new MeshStandardMaterial({ color: BOARD_COLOR, roughness: 0.7, metalness: 0.05 });
  mats.push(boardMat);
  const slab = new Mesh(new BoxGeometry(sx, sy, board.thickness_mm).translate(0, 0, board.z_mm + board.thickness_mm / 2), boardMat);
  slab.raycast = () => {};
  g.add(slab);
  const top = board.z_mm + board.thickness_mm;
  const holeMat = new MeshBasicMaterial({ color: 0xc9b26a, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  for (const h of part.mounting_holes) {
    const disc = new Mesh(new CircleGeometry(h.d_mm / 2, 20), new MeshBasicMaterial({ color: 0x15181c, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    disc.position.set(h.p_mm[0], h.p_mm[1], top + 0.02);
    disc.raycast = () => {};
    const pad = new Mesh(new CircleGeometry(h.d_mm * 0.85, 24), holeMat);
    pad.position.set(h.p_mm[0], h.p_mm[1], top + 0.01);
    pad.raycast = () => {};
    g.add(pad, disc);
  }
  if (connectors) {
    const housingMat = new MeshStandardMaterial({ color: HOUSING_COLOR, roughness: 0.5 });
    mats.push(housingMat);
    for (const port of part.ports) {
      const conn = findConnector(connectors, port.connector);
      const ways = conn ? portWays(conn, port) : undefined;
      const box = conn && ways ? connectorBoxes(conn, ways).housing : undefined;
      if (!box) continue;
      const [len, w, h] = box;
      const m = new Mesh(new BoxGeometry(len, w, h).translate(-len / 2, 0, 0), housingMat);
      m.position.set(...port.pose.p_mm);
      m.quaternion.set(...port.pose.q).normalize();
      m.raycast = () => {};
      g.add(m);
    }
  }
  return g;
}

export function buildPartVisual(part: Part, opts: PartVisualOptions = {}): PartVisual {
  const [sx, sy, sz] = part.body.size_mm;
  const group = new Group();
  const preview = !!opts.preview;
  const boxGeo = new BoxGeometry(sx, sy, sz).translate(0, 0, sz / 2);
  const boxMaterial = new MeshStandardMaterial({
    color: partColor(part),
    roughness: 0.55,
    metalness: 0.05,
    transparent: preview,
    opacity: preview ? 0.55 : 1,
    depthWrite: !preview,
  });
  const body = new Mesh(boxGeo, boxMaterial);
  body.renderOrder = preview ? 5 : 0;
  group.add(body);
  const edges = new LineSegments(new EdgesGeometry(boxGeo), new LineBasicMaterial({ color: 0x111418, transparent: true, opacity: 0.7 }));
  edges.raycast = () => {};
  group.add(edges);

  // Case (c) holes on the top face; (b) draws its own on the board.
  const boxHoles = new Group();
  const holeMat = new MeshBasicMaterial({ color: 0x15181c, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const ringMat = new LineBasicMaterial({ color: 0xd8dde3 });
  for (const h of part.mounting_holes) {
    const disc = new Mesh(new CircleGeometry(h.d_mm / 2, 20), holeMat);
    disc.position.set(h.p_mm[0], h.p_mm[1], sz + 0.02);
    disc.raycast = () => {};
    const rl = new LineLoop(ring(h.d_mm * 0.8), ringMat);
    rl.position.copy(disc.position);
    rl.raycast = () => {};
    boxHoles.add(disc, rl);
  }
  group.add(boxHoles);

  // The envelope shown as a faint outline only (cases a and b): still pickable.
  const outline = () => {
    boxMaterial.transparent = true;
    boxMaterial.opacity = preview ? 0.12 : 0.06;
    boxMaterial.depthWrite = false;
    boxMaterial.needsUpdate = true;
    (edges.material as LineBasicMaterial).opacity = 0.35;
    boxHoles.visible = false;
  };

  const visible: MeshStandardMaterial[] = [boxMaterial];
  let kind: 'model' | 'board' | 'box' = 'box';
  let detail: Group | null = null;
  const useBoard = () => {
    if (!part.body.board) return;
    const mats: MeshStandardMaterial[] = [];
    detail = boardGroup(part, opts.connectors, mats);
    detail.userData.partSurface = true;
    group.add(detail);
    visible.splice(0, visible.length, ...mats, boxMaterial);
    outline();
    kind = 'board';
  };

  let ready: Promise<void> = Promise.resolve();
  if (isDrawableModel(part.model)) {
    // Placeholder: the envelope box, until the model is in.
    ready = loadPartModel(part.model, opts.onModelFail).then(
      (template) => {
        const model = instanceModel(template);
        model.traverse((o) => (o.raycast = () => {}));
        if (preview)
          model.traverse((o) => {
            const m = o as Mesh;
            if (m.isMesh) Object.assign(m.material as MeshStandardMaterial, { transparent: true, opacity: 0.6, depthWrite: false });
          });
        group.add(model);
        const mats: MeshStandardMaterial[] = [];
        model.traverse((o) => {
          const m = o as Mesh;
          if (m.isMesh) mats.push(m.material as MeshStandardMaterial);
        });
        visible.splice(0, visible.length, ...mats, boxMaterial);
        outline();
        boxMaterial.opacity = 0;
        model.userData.partSurface = true;
        (edges.material as LineBasicMaterial).opacity = 0.15;
        kind = 'model';
        opts.onModel?.();
      },
      () => {
        useBoard();
        opts.onModel?.();
      },
    );
  } else useBoard();

  if (opts.showConnectorBoxes && opts.connectors) {
    const housingMat = new MeshStandardMaterial({ color: HOUSING_COLOR, roughness: 0.5 });
    const plugMat = new MeshStandardMaterial({ color: 0x5aa0e6, transparent: true, opacity: 0.4, depthWrite: false });
    for (const port of part.ports) {
      const conn = findConnector(opts.connectors, port.connector);
      const ways = conn ? portWays(conn, port) : undefined;
      if (!conn || !ways) continue;
      const boxes = connectorBoxes(conn, ways);
      const frame = new Group();
      frame.position.set(...port.pose.p_mm);
      frame.quaternion.set(...port.pose.q).normalize();
      if (boxes.housing) {
        const [l, w, h] = boxes.housing;
        frame.add(new Mesh(new BoxGeometry(l, w, h).translate(-l / 2, 0, 0), housingMat));
      }
      if (boxes.plug) {
        const [l, w, h] = boxes.plug;
        frame.add(new Mesh(new BoxGeometry(l, w, h).translate(l / 2, 0, 0), plugMat));
      }
      frame.traverse((o) => (o.raycast = () => {}));
      group.add(frame);
    }
  }

  // Ports: arrow along +X of the port frame, plus a pickable marker.
  const portMarkers: Mesh[] = [];
  const arrowLen = Math.max(6, Math.min(sx, sy) * 0.3);
  const markerGeo = new SphereGeometry(Math.max(1.2, arrowLen * 0.16), 12, 8);
  const markerMat = new MeshBasicMaterial({ color: 0xf2c230 });
  for (const port of part.ports) {
    const q = new Quaternion(...port.pose.q).normalize();
    const dir = new Vector3(1, 0, 0).applyQuaternion(q);
    const origin = new Vector3(...port.pose.p_mm);
    const arrow = new ArrowHelper(dir, origin, arrowLen, 0xf2c230, arrowLen * 0.35, arrowLen * 0.22);
    arrow.traverse((o) => (o.raycast = () => {}));
    const marker = new Mesh(markerGeo, markerMat);
    marker.position.copy(origin);
    marker.userData.portId = port.id;
    group.add(arrow, marker);
    portMarkers.push(marker);
  }
  return {
    group,
    body,
    bodyMaterial: boxMaterial,
    portMarkers,
    setEmissive: (c: Color) => {
      for (const m of visible) m.emissive.copy(c);
    },
    kind: () => kind,
    ready,
  };
}

export function disposeObject(root: Object3D): void {
  const seen = new Set<unknown>();
  root.traverse((o) => {
    const m = o as Mesh;
    if (m.geometry && !seen.has(m.geometry) && !m.geometry.userData.shared) {
      seen.add(m.geometry);
      m.geometry.dispose();
    }
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats as Material[]) {
      if (!seen.has(mat)) {
        seen.add(mat);
        mat.dispose();
      }
    }
  });
}
