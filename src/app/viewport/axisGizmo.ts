/** World-space display of a proposed joint axis: a long line, an arrow and the axis point. */
import { ArrowHelper, BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';

export class AxisGizmo extends Group {
  private line: LineSegments;
  private arrow: ArrowHelper;
  private dot: Mesh;

  constructor(color = 0xff3fb0) {
    super();
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    this.line = new LineSegments(g, new LineBasicMaterial({ color, depthTest: false, transparent: true }));
    this.arrow = new ArrowHelper(new Vector3(0, 0, 1), new Vector3(), 1, color);
    this.dot = new Mesh(new SphereGeometry(1, 16, 10), new MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    for (const o of [this.line, this.arrow, this.dot]) {
      o.renderOrder = 30;
      o.traverse((c) => {
        c.raycast = () => {};
        const m = (c as Mesh).material as MeshBasicMaterial | undefined;
        if (m) m.depthTest = false;
      });
    }
    this.add(this.line, this.arrow, this.dot);
    this.visible = false;
  }

  show(point: readonly number[] | null, dir: readonly number[] | null, size: number): void {
    if (!point || !dir) {
      this.visible = false;
      return;
    }
    const p = new Vector3(point[0], point[1], point[2]);
    const d = new Vector3(dir[0], dir[1], dir[2]).normalize();
    const half = Math.max(size, 1);
    const pos = this.line.geometry.getAttribute('position') as Float32BufferAttribute;
    const a = p.clone().addScaledVector(d, -half);
    const b = p.clone().addScaledVector(d, half);
    pos.setXYZ(0, a.x, a.y, a.z);
    pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    this.arrow.position.copy(p);
    this.arrow.setDirection(d);
    this.arrow.setLength(half * 0.6, half * 0.12, half * 0.06);
    this.dot.position.copy(p);
    this.dot.scale.setScalar(half * 0.025);
    this.visible = true;
  }
}
