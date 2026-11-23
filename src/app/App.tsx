import { useEffect, useState } from 'react';
import { readDataTransfer } from './io/files';
import { openFiles, openPerfModel } from './io/load';
import { useApp } from './state/store';
import { JointEditor } from './ui/JointEditor';
import { JointPanel } from './ui/JointPanel';
import { AddPartDialog } from './ui/AddPartDialog';
import { AddCableDialog } from './ui/AddCableDialog';
import { ConfirmDialog, Notices, PerfReadout, ProgressBar, UnitDialog } from './ui/Overlays';
import { Properties } from './ui/Properties';
import { deleteComponent, duplicateComponent } from './ui/ComponentProps';
import { ComparePanel } from './ui/ComparePanel';
import { commitWireEdit } from './wires/editing';
import { removeWire } from './wires/routeEdit';
import { LeftPanel } from './ui/LeftPanel';
import { PortTooltip, ToolOptions } from './ui/ToolOptions';
import { deleteZone } from './ui/ZoneList';
import { StatusBar } from './ui/StatusBar';
import { Toolbar } from './ui/Toolbar';
import { ViewportHost } from './ui/ViewportHost';
import { PanelSection, SidePanel } from './ui/SidePanel';
import { ToolPill, ViewControls, Welcome } from './ui/ViewportOverlays';
import { getViewport } from './viewport/instance';
import type { Viewport } from './viewport/Viewport';

const params = new URLSearchParams(location.search);
const perfTriangles = Number(params.get('perf') ?? '');
const perfMode = Number.isFinite(perfTriangles) && perfTriangles > 0;
const autospin = params.get('autospin') === '1';
let startupDone = false;

function startup(v: Viewport): void {
  if (startupDone) {
    if (useApp.getState().design.scene.links.length > 0) v.onModelLoaded();
    v.setAutospin(autospin);
    return;
  }
  startupDone = true;
  if (perfMode) openPerfModel(Math.round(perfTriangles));
  v.setAutospin(autospin);
}

function isTextField(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  return t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'button';
}

function onKeyDown(e: KeyboardEvent): void {
  const s = useApp.getState();
  if (s.confirm || s.unitRequest) return;
  if (isTextField(e.target)) return;
  // A dialog open (modal, or the focus inside one): its keys are its own, nothing acts on the design behind it.
  if (document.querySelector('[aria-modal="true"]')) return;
  const inDialog = e.target instanceof Element && e.target.closest('[role="dialog"]');
  if (inDialog) return;
  const v = getViewport();
  if (v?.handleKey(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    s.undo();
  } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
    e.preventDefault();
    s.redo();
  } else if (mod && key === 'd' && s.selection?.kind === 'component') {
    e.preventDefault();
    duplicateComponent(s.selection.id);
  } else if (!mod && !e.altKey && key === 'f') {
    e.preventDefault();
    v?.fit(s.selection ? 'selection' : 'all');
  } else if (key === 'escape') {
    if (s.activeTool !== 'select') s.setActiveTool('select');
    else if (s.compareCable) useApp.setState({ compareCable: null });
    else s.select(null);
  } else if ((key === 'delete' || key === 'backspace') && !mod && s.wirePoint && s.selection?.kind === 'cable' && s.wirePoint.cableId === s.selection.id) {
    // Delete the selected point of the selected wire.
    e.preventDefault();
    const wp = s.wirePoint;
    commitWireEdit(wp.cableId, { kind: 'delete', index: wp.index });
    useApp.setState({ wirePoint: null });
  } else if ((key === 'delete' || key === 'backspace') && !mod) {
    const sel = s.selection;
    if (sel?.kind === 'component') {
      e.preventDefault();
      deleteComponent(sel.id);
    } else if (sel?.kind === 'cable') {
      e.preventDefault();
      const id = sel.id;
      s.commit((d) => removeWire(d, id));
      s.select(null);
    } else if (sel?.kind === 'zone') {
      e.preventDefault();
      deleteZone(sel.id);
    }
  } else if (key === 'alt' && s.activeTool === 'zones') {
    // Alt erases while painting; keep the browser from focusing its menu.
    e.preventDefault();
  }
}

function Marquee() {
  const m = useApp((s) => s.marquee);
  if (!m) return null;
  return (
    <div
      className="marquee"
      style={{ left: Math.min(m.x0, m.x1), top: Math.min(m.y0, m.y1), width: Math.abs(m.x1 - m.x0), height: Math.abs(m.y1 - m.y0) }}
      aria-hidden="true"
    />
  );
}

function JointsSection() {
  const n = useApp((s) => s.design.scene.joints.length);
  return (
    <PanelSection title="Joints" count={n} storageKey="wiring-design.section.joints">
      <JointPanel />
    </PanelSection>
  );
}

export function App() {
  // The tab carries the design's name.
  const designName = useApp((s) => s.design.meta.name);
  useEffect(() => {
    document.title = designName && designName !== 'Untitled' ? `${designName} - Wiring Design` : 'Wiring Design: route and check cables on a 3D model';
  }, [designName]);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    const warn = (e: BeforeUnloadEvent) => {
      const s = useApp.getState();
      if (s.design !== s.savedDesign) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const pending = readDataTransfer(e.dataTransfer);
        void pending
          .then(openFiles)
          .catch((err: unknown) => useApp.getState().notify('error', 'The dropped files could not be read', [String(err)]));
      }}
    >
      <Toolbar />
      <main className="workspace">
        <SidePanel side="left" label="Model, areas, parts and wires" storageKey="wiring-design.panel.left" min={240} max={480} initial={300}>
          <LeftPanel />
        </SidePanel>
        <section className="viewport" aria-label="3D view">
          <ViewportHost onReady={startup} />
          <Welcome />
          <ViewControls />
          <ToolPill />
          <ToolOptions />
          <ComparePanel />
          <Marquee />
          <PortTooltip />
          <Notices />
          <ProgressBar />
          {perfMode && <PerfReadout />}
          {dragging && <div className="drop-hint">Drop to open</div>}
        </section>
        <SidePanel side="right" label="Joints and properties" storageKey="wiring-design.panel.right" min={260} max={520} initial={320}>
          <JointEditor />
          <div className="psecs">
            <JointsSection />
            <PanelSection title="Properties" storageKey="wiring-design.section.properties">
              <Properties />
            </PanelSection>
          </div>
        </SidePanel>
      </main>
      <StatusBar />
      <ConfirmDialog />
      <AddPartDialog />
      <AddCableDialog />
      <UnitDialog />
    </div>
  );
}
