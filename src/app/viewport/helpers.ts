/** Ground grid and axes indicator for a Z-up, millimetre world. */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  OrthographicCamera,
  Scene,
  Sprite,
  SpriteMaterial,
  type Camera,
  type WebGLRenderer,
} from 'three';

export interface Theme {
  dark: boolean;
  /** The view's background colour (the page draws a gradient behind a transparent canvas; this is its middle tone). */
  background: Color;
  gridMinor: Color;
  gridMajor: Color;
  /** Feature edges drawn on the model. */
  edge: Color;
}

/** The theme in effect: `<html data-theme>` (set by ui/theme.ts), else the system's. */
export function currentTheme(): Theme {
  const attr = typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  const dark = attr ? attr === 'dark' : typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  return dark
    ? { dark, background: new Color(0x1b1e22), gridMinor: new Color(0x2c3036), gridMajor: new Color(0x41474f), edge: new Color(0x0c0d0f) }
    : { dark, background: new Color(0xeceef1), gridMinor: new Color(0xd3d7dc), gridMajor: new Color(0xaeb4bb), edge: new Color(0x3b4048) };
}

/** Grid spacing for a model of this size: minor cells about 1/10 of the model. */
export function gridSpacing(sizeMm: number): { minor: number; major: number; extent: number } {
  const s = Math.max(sizeMm, 1);
  const minor = 10 ** Math.floor(Math.log10(s / 10));
  const major = minor * 10;
  const extent = Math.ceil((s * 2) / major) * major;
  return { minor, major, extent };
}

/** A square grid in the XY plane centred on the origin. */
export class Grid extends Group {
  private minorLines: LineSegments;
  private majorLines: LineSegments;
  spacing = gridSpacing(1000);

  constructor(theme: Theme) {
    super();
    // Vertex alpha fades the lines towards the edge of the grid.
    this.minorLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: theme.gridMinor, vertexColors: true, transparent: true, depthWrite: false }));
    this.majorLines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: theme.gridMajor, vertexColors: true, transparent: true, depthWrite: false }));
    this.minorLines.raycast = () => {};
    this.majorLines.raycast = () => {};
    this.minorLines.renderOrder = -2;
    this.majorLines.renderOrder = -1;
    this.add(this.minorLines, this.majorLines);
    this.setSize(1000);
  }

  setTheme(theme: Theme): void {
    (this.minorLines.material as LineBasicMaterial).color.copy(theme.gridMinor);
    (this.majorLines.material as LineBasicMaterial).color.copy(theme.gridMajor);
  }

  setSize(modelSizeMm: number): void {
    this.spacing = gridSpacing(modelSizeMm);
    const { minor, major, extent } = this.spacing;
    const build = (step: number, skip: number | null) => {
      const pts: number[] = [];
      const cols: number[] = [];
      const n = Math.round(extent / step);
      // Each line is split in short pieces so its alpha can fall off with the distance from the centre.
      const pieces = 16;
      const fade = (x: number, y: number) => Math.max(0, 1 - (Math.hypot(x, y) / extent) ** 2);
      for (let i = -n; i <= n; i++) {
        const v = i * step;
        if (skip && Math.abs(Math.round(v / skip) * skip - v) < step * 1e-3) continue;
        for (let k = 0; k < pieces; k++) {
          const a = -extent + (2 * extent * k) / pieces;
          const b = -extent + (2 * extent * (k + 1)) / pieces;
          pts.push(v, a, 0, v, b, 0, a, v, 0, b, v, 0);
          cols.push(1, 1, 1, fade(v, a), 1, 1, 1, fade(v, b), 1, 1, 1, fade(a, v), 1, 1, 1, fade(b, v));
        }
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pts, 3));
      g.setAttribute('color', new Float32BufferAttribute(cols, 4));
      return g;
    };
    this.minorLines.geometry.dispose();
    this.majorLines.geometry.dispose();
    this.minorLines.geometry = build(minor, major);
    this.majorLines.geometry = build(major, null);
  }
}

function label(text: string, color: string): Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 32, 34);
  const s = new Sprite(new SpriteMaterial({ map: new CanvasTexture(c), depthTest: false }));
  s.scale.setScalar(0.5);
  return s;
}

/** Small XYZ triad drawn in a corner, following the main camera's rotation. */
export class AxesGizmo {
  readonly scene = new Scene();
  readonly camera = new OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  readonly size = 84;

  constructor() {
    const axes: Array<[number[], string]> = [
      [[1, 0, 0], '#e0524a'],
      [[0, 1, 0], '#4caf50'],
      [[0, 0, 1], '#4a86e0'],
    ];
    const names = ['X', 'Y', 'Z'];
    axes.forEach(([d, color], i) => {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, d[0]!, d[1]!, d[2]!], 3));
      this.scene.add(new LineSegments(g, new LineBasicMaterial({ color, depthTest: false })));
      const l = label(names[i]!, color);
      l.position.set(d[0]! * 1.3, d[1]! * 1.3, d[2]! * 1.3);
      this.scene.add(l);
    });
  }

  render(renderer: WebGLRenderer, main: Camera, height: number): void {
    this.camera.quaternion.copy(main.quaternion);
    this.camera.position.set(0, 0, 4).applyQuaternion(main.quaternion);
    this.camera.updateMatrixWorld();
    const s = this.size;
    renderer.setScissorTest(true);
    renderer.setViewport(8, 8, s, s);
    renderer.setScissor(8, 8, s, s);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    void height;
  }
}
