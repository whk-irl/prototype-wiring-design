/**
 * What floats over the 3D view: the view controls (top right), the active
 * tool's one-line instructions (a pill at the top), and the welcome panel
 * when no model is open.
 */
import { openDemoArm, openSample } from '../io/load';
import { useApp } from '../state/store';
import { getViewport } from '../viewport/instance';
import type { StandardView } from '../viewport/Viewport';
import { IconCube, IconEdges, IconFit, IconFolder, IconGrid, IconModel, Logo } from './icons';
import { openModelPicker, useSamples } from './Toolbar';
import { Menu } from './Menu';

/** Turn a view toggle and remember it on this PC. */
function setView(name: 'grid' | 'edges', on: boolean): void {
  useApp.setState(name === 'grid' ? { viewGrid: on } : { viewEdges: on });
  try {
    localStorage.setItem(`wiring-design.view.${name}`, on ? 'on' : 'off');
  } catch {
    // session only
  }
}

const VIEWS: Array<[StandardView, string, string]> = [
  ['iso', 'Iso', 'Isometric view'],
  ['front', 'Front', 'Front view'],
  ['right', 'Right', 'Right view'],
  ['top', 'Top', 'Top view'],
];

export function ViewControls() {
  const hasModel = useApp((s) => s.design.scene.links.length > 0);
  const grid = useApp((s) => s.viewGrid);
  const edges = useApp((s) => s.viewEdges);
  const edgesSkipped = useApp((s) => s.edgesSkipped);
  if (!hasModel) return null;
  return (
    <div className="view-controls" role="toolbar" aria-label="View">
      <div className="vc-group" role="group" aria-label="View direction">
        {VIEWS.map(([v, label, aria]) => (
          <button key={v} type="button" className="vc-btn" onClick={() => getViewport()?.setView(v)} aria-label={aria} title={aria}>
            {label}
          </button>
        ))}
      </div>
      <div className="vc-group" role="group" aria-label="Display">
        <button
          type="button"
          className="vc-btn icon-only"
          onClick={() => getViewport()?.fit(useApp.getState().selection ? 'selection' : 'all')}
          title="Fit view to selection or model (F)"
          aria-label="Fit view"
        >
          <IconFit />
        </button>
        <button type="button" className="vc-btn icon-only" aria-pressed={grid} onClick={() => setView('grid', !grid)} title={grid ? 'Hide the grid' : 'Show the grid'} aria-label="Grid">
          <IconGrid />
        </button>
        <button
          type="button"
          className="vc-btn icon-only"
          aria-pressed={edges && !edgesSkipped}
          onClick={() => setView('edges', !edges)}
          title={edgesSkipped ? 'Edges are off for a model this large, to keep the view fast' : edges ? 'Hide the edges' : 'Show the edges'}
          aria-label="Edges"
        >
          <IconEdges />
        </button>
      </div>
    </div>
  );
}

/** The active tool in one line: what to click and how to finish. */
export function ToolPill() {
  const tool = useApp((s) => s.activeTool);
  // Clicks, not points: a click's drape adds points the user did not place.
  const clicks = useApp((s) => s.wireDraft?.marks?.length ?? 0);
  const port = useApp((s) => s.portHover);
  const picking = useApp((s) => s.portPickPart !== null);
  let text: string | null = null;
  if (tool === 'wire') {
    const where = port ? ` Over port ${port.portId}.` : '';
    text = clicks
      ? `Draw wire: ${clicks} click${clicks === 1 ? '' : 's'}.${where} Click to add; Enter finishes, Backspace removes the last, Esc cancels.`
      : `Draw wire: click a port or the model to start.${where} Enter finishes, Esc cancels.`;
  }
  else if (tool === 'axis') text = 'Pick the joint axis: click a pin, shaft, hole or flat round face. Esc stops.';
  else if (tool === 'port' && picking) text = 'Add port: click the part where the connector is. Esc stops.';
  if (!text) return null;
  return (
    <div className="tool-pill" role="status">
      {text}
    </div>
  );
}

export function Welcome() {
  const hasModel = useApp((s) => s.design.scene.links.length > 0);
  const busy = useApp((s) => s.progress !== null);
  const samples = useSamples();
  if (hasModel || busy) return null;
  return (
    <div className="welcome" role="region" aria-label="Get started">
      <div className="welcome-head">
        <Logo size={32} />
        <div>
          <h2>Wiring Design</h2>
          <p className="muted">Route the wires of a robot or machine on its 3D model, and check them before you build.</p>
        </div>
      </div>
      <div className="welcome-actions">
        <button type="button" className="primary" onClick={() => void openModelPicker(false)}>
          <IconCube /> Open a model
        </button>
        <button type="button" onClick={() => void openDemoArm()}>
          <IconModel /> Load the demo arm
        </button>
        {samples.length > 0 && (
          <Menu
            label="Open a sample"
            icon={<IconFolder />}
            entries={samples.map((s) => ({ label: s.title, ...(s.description ? { detail: s.description } : {}), onSelect: () => void openSample(s) }))}
          />
        )}
      </div>
      <p className="welcome-drop muted small">Or drop STEP, IGES, glTF, STL or OBJ files here, or a folder with a URDF and its meshes.</p>
      <ol className="welcome-steps">
        <li>
          <strong>Model</strong>
          <span>Open the model and set up its joints.</span>
        </li>
        <li>
          <strong>Parts</strong>
          <span>Place boards, sensors and motors on it.</span>
        </li>
        <li>
          <strong>Wires</strong>
          <span>Draw each wire from port to port.</span>
        </li>
        <li>
          <strong>Check and export</strong>
          <span>Fix what fails, then save and export the cut list.</span>
        </li>
      </ol>
    </div>
  );
}
