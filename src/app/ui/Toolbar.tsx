/**
 * The header: the app's mark and the design's name (click to rename; a dot
 * when there are unsaved changes), the tools, undo and redo, one Open menu,
 * Save as the one primary action (with a menu for part files), the theme and
 * help. Below about 1100 px wide the labels give way to icons (with
 * tooltips), so the header never scrolls sideways.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { pickFiles, readFiles } from '../io/files';
import { loadSampleIndex, openDemoArm, openFiles, openProject, openSample, saveDesign, type SampleEntry } from '../io/load';
import { startNewJoint } from '../joints/editor';
import { isDirty, useApp } from '../state/store';
import { exportDesignPartFiles } from '../userParts/actions';
import { HelpDialog } from './HelpDialog';
import {
  IconBrush,
  IconChevronDown,
  IconCube,
  IconFile,
  IconFolder,
  IconHelp,
  IconJoint,
  IconModel,
  IconMoon,
  IconRedo,
  IconSave,
  IconSelect,
  IconSun,
  IconUndo,
  IconWire,
  Logo,
} from './icons';
import { Menu, type MenuEntry } from './Menu';
import { resolvedTheme, setThemeChoice } from './theme';

const MODEL_ACCEPT = '.step,.stp,.iges,.igs,.glb,.gltf,.bin,.stl,.obj,.urdf,.dae,.png,.jpg';

export async function openModelPicker(directory: boolean): Promise<void> {
  const picked = await pickFiles({ multiple: true, directory, accept: directory ? undefined : MODEL_ACCEPT });
  if (picked.length === 0) return;
  await openFiles(await readFiles(picked));
}

async function openProjectPicker(): Promise<void> {
  const picked = await pickFiles({ multiple: true });
  if (picked.length === 0) return;
  const files = await readFiles(picked);
  const designFile = files.find((f) => f.path.toLowerCase().endsWith('.json'));
  if (!designFile) {
    useApp
      .getState()
      .notify('error', 'No design file chosen', ['Select the design.json together with the model files it uses (hold Ctrl to pick several), or use Open folder on a folder that contains them.']);
    return;
  }
  await openProject(designFile, files.filter((f) => f !== designFile));
}

/** The samples, loaded once. */
export function useSamples(): SampleEntry[] {
  const [samples, setSamples] = useState<SampleEntry[]>([]);
  useEffect(() => {
    void loadSampleIndex().then((x) => setSamples(x ?? []));
  }, []);
  return samples;
}

function DesignTitle() {
  const name = useApp((s) => s.design.meta.name);
  const dirty = useApp(isDirty);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const commit = () => {
    setEditing(false);
    const v = text.trim();
    if (!v || v === name) return setText(name);
    useApp.getState().commit((d) => ({ ...d, meta: { ...d.meta, name: v } }));
  };
  return (
    <div className="hdr-title">
      {editing ? (
        <input
          className="text hdr-name-input"
          autoFocus
          value={text}
          aria-label="Design name"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button type="button" className="hdr-name" title={`${name} (click to rename)`} aria-label={`Design name: ${name}. Click to rename.`} onClick={() => setEditing(true)}>
          <span className="ellipsis">{name}</span>
        </button>
      )}
      {dirty && <span className="dirty-dot" title="Unsaved changes" role="img" aria-label="Unsaved changes" />}
    </div>
  );
}

function ToolButton(props: { active?: boolean; disabled?: boolean; onClick: () => void; icon: ReactNode; label: string; title: string }) {
  return (
    <button type="button" className="hdr-btn" aria-pressed={props.active ?? false} disabled={props.disabled} onClick={props.onClick} title={props.title} aria-label={props.label}>
      {props.icon}
      <span className="btn-label">{props.label}</span>
    </button>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(resolvedTheme());
  useEffect(() => {
    const on = () => setTheme(resolvedTheme());
    window.addEventListener('wd-theme', on);
    return () => window.removeEventListener('wd-theme', on);
  }, []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="hdr-btn icon-only" onClick={() => setThemeChoice(next)} title={`Switch to the ${next} theme`} aria-label={`Switch to the ${next} theme`}>
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

export function Toolbar() {
  const canUndo = useApp((s) => s.past.length > 0);
  const canRedo = useApp((s) => s.future.length > 0);
  const hasModel = useApp((s) => s.design.scene.links.length > 0);
  const busy = useApp((s) => s.progress !== null);
  const tool = useApp((s) => s.activeTool);
  const drafting = useApp((s) => s.jointDraft !== null);
  const customParts = useApp((s) => s.design.parts.filter((p) => p.custom).length);
  const samples = useSamples();
  const [help, setHelp] = useState(false);

  const open: MenuEntry[] = [
    { label: 'Open model...', detail: 'STEP, IGES, glTF, STL, OBJ or URDF files', icon: <IconCube />, disabled: busy, onSelect: () => void openModelPicker(false) },
    { label: 'Open folder...', detail: 'A URDF with its meshes, or a project folder', icon: <IconFolder />, disabled: busy, onSelect: () => void openModelPicker(true) },
    { label: 'Open project...', detail: 'A design.json with its model files', icon: <IconFile />, disabled: busy, onSelect: () => void openProjectPicker() },
    'separator',
    { label: 'Demo arm', detail: 'A three-joint arm to try things on', icon: <IconModel />, disabled: busy, onSelect: () => void openDemoArm() },
    ...(samples.length ? [{ heading: 'Samples' } as MenuEntry] : []),
    ...samples.map((s): MenuEntry => ({ label: s.title, ...(s.description ? { detail: s.description } : {}), disabled: busy, onSelect: () => void openSample(s) })),
  ];
  const saveMore: MenuEntry[] = [
    { label: 'Save design', detail: 'Download the design as a .json file', icon: <IconSave />, disabled: !hasModel, onSelect: saveDesign },
    {
      label: 'Export part files',
      detail: customParts ? `${customParts} part${customParts === 1 ? '' : 's'} of your own, to send with design.json` : 'This design uses no parts of your own',
      icon: <IconFile />,
      disabled: customParts === 0,
      onSelect: () => void exportDesignPartFiles(),
    },
  ];
  const toggle = (id: string) => useApp.getState().setActiveTool(tool === id ? 'select' : id);

  return (
    <header className="header" aria-label="Main toolbar">
      <div className="hdr-brand">
        <Logo />
        <span className="hdr-app">Wiring Design</span>
        <span className="hdr-sep" aria-hidden="true">
          /
        </span>
        <DesignTitle />
      </div>
      <Menu label="Open" icon={<IconFolder />} entries={open} buttonClass="hdr-btn" title="Open a model, a project, the demo arm or a sample" />
      <div className="hdr-group seg-tools" role="group" aria-label="Tool">
        <ToolButton active={tool === 'select'} onClick={() => useApp.getState().setActiveTool('select')} icon={<IconSelect />} label="Select" title="Select and drag parts (Esc)" />
        <ToolButton active={tool === 'zones'} disabled={!hasModel} onClick={() => toggle('zones')} icon={<IconBrush />} label="Paint areas" title="Paint areas where parts may go, and areas to keep clear" />
        <ToolButton active={tool === 'wire'} disabled={!hasModel} onClick={() => toggle('wire')} icon={<IconWire />} label="Draw wire" title="Draw a wire with the chosen cable" />
        <ToolButton disabled={!hasModel || drafting} onClick={() => startNewJoint()} icon={<IconJoint />} label="New joint" title="Turn the selected parts into a link on a new joint" />
      </div>
      <div className="hdr-group" role="group" aria-label="History">
        <button type="button" className="hdr-btn icon-only" disabled={!canUndo} onClick={() => useApp.getState().undo()} title="Undo (Ctrl+Z)" aria-label="Undo">
          <IconUndo />
        </button>
        <button type="button" className="hdr-btn icon-only" disabled={!canRedo} onClick={() => useApp.getState().redo()} title="Redo (Ctrl+Y)" aria-label="Redo">
          <IconRedo />
        </button>
      </div>
      <span className="hdr-spacer" />
      <div className="split" role="group" aria-label="Save">
        <button type="button" className="primary hdr-btn" disabled={!hasModel} onClick={saveDesign} title="Download design.json" aria-label="Save design">
          <IconSave />
          <span className="btn-label">Save design</span>
        </button>
        <Menu label="More save options" hideLabel icon={<IconChevronDown />} entries={saveMore} buttonClass="primary hdr-btn split-more" align="right" />
      </div>
      <div className="hdr-group" role="group" aria-label="Appearance and help">
        <ThemeToggle />
        <button type="button" className="hdr-btn icon-only" onClick={() => setHelp(true)} title="Help: shortcuts and about" aria-label="Help">
          <IconHelp />
        </button>
      </div>
      {help && <HelpDialog onClose={() => setHelp(false)} />}
    </header>
  );
}
