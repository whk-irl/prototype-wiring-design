import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../state/store';
import { IconArea, IconModel, IconPart, IconWire } from './icons';
import { PartsList } from './PartsList';
import { SceneTree } from './SceneTree';
import { WiresPanel } from './WiresPanel';
import { ZoneList } from './ZoneList';

type Tab = 'scene' | 'zones' | 'parts' | 'wires';
// In the order of work: the model and its joints, the optional areas, then parts, then wires.
const TABS: Array<[Tab, string, ReactNode]> = [
  ['scene', 'Model', <IconModel key="m" />],
  ['zones', 'Areas', <IconArea key="a" />],
  ['parts', 'Parts', <IconPart key="p" />],
  ['wires', 'Wires', <IconWire key="w" />],
];

export function LeftPanel() {
  const [tab, setTab] = useState<Tab>('scene');
  const counts: Record<Tab, number> = {
    scene: useApp((s) => s.design.scene.links.length),
    zones: useApp((s) => s.design.zones.length),
    parts: useApp((s) => s.design.components.length),
    wires: useApp((s) => s.design.cables.length),
  };
  const tool = useApp((s) => s.activeTool);
  const selKind = useApp((s) => s.selection?.kind);
  // Follow the user's activity: painting shows zones, placing shows parts.
  useEffect(() => {
    if (tool === 'zones') setTab('zones');
    if (tool === 'place') setTab('parts');
    if (tool === 'wire') setTab('wires');
  }, [tool]);
  useEffect(() => {
    if (selKind === 'zone') setTab('zones');
    if (selKind === 'cable') setTab('wires');
  }, [selKind]);

  return (
    <>
      <div
        className="tabs"
        role="tablist"
        aria-label="Left panel"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const i = TABS.findIndex(([id]) => id === tab);
          const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]![0];
          setTab(next);
          document.getElementById(`tab-${next}`)?.focus();
        }}
      >
        {TABS.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            title={`${label}${counts[id] ? ` (${counts[id]})` : ''}`}
          >
            {icon}
            <span className="tab-label">{label}</span>
            {counts[id] > 0 && <span className="count">{counts[id]}</span>}
          </button>
        ))}
      </div>
      <div key={tab} className="panel-body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'scene' && <SceneTree />}
        {tab === 'zones' && <ZoneList />}
        {tab === 'parts' && <PartsList />}
        {tab === 'wires' && <WiresPanel />}
      </div>
    </>
  );
}
