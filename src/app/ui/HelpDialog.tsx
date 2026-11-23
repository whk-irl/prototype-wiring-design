/** Help: the keyboard shortcuts, what the app is, and where it lives. */
import { Dialog } from './Dialog';
import { Logo } from './icons';
import pkg from '../../../package.json';

/** The repository from package.json (`repository`, a URL or { url }), read at build time; nothing shown when it is not set. */
const REPOSITORY: string = (() => {
  const r = (pkg as { repository?: string | { url?: string } }).repository;
  const url = typeof r === 'string' ? r : r?.url;
  if (!url) return '';
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
})();

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Y or Ctrl+Shift+Z', 'Redo'],
  ['Esc', 'Back to Select, or clear the selection'],
  ['F', 'Fit the view to the selection or the model'],
  ['Del', 'Delete the selected part, wire, area or wire point'],
  ['Ctrl+D', 'Duplicate the selected part'],
  ['R', 'Turn a part 15 degrees while placing it'],
  ['Enter', 'Finish the wire being drawn'],
  ['Backspace', 'Remove the last point of the wire being drawn'],
  ['Shift+click', 'Place another of the same part; pass a wire through a hole'],
  ['Ctrl+click', 'Add a point to the selected wire; add a part to the selection'],
  ['Alt (painting)', 'Erase painted areas'],
  ['Drag / right-drag / wheel', 'Orbit / pan / zoom the view'],
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title="Help"
      onClose={onClose}
      className="help"
      footer={
        <button type="button" className="primary" onClick={onClose} data-autofocus>
          Close
        </button>
      }
    >
      <div className="help-about">
        <Logo size={36} />
        <div>
          <strong>Wiring Design</strong>
          <div className="muted">Route the wires of a robot or machine on its 3D model, and check them before you build.</div>
        </div>
      </div>
      <h3 className="section-label">Keyboard</h3>
      <dl className="shortcut-list">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="shortcut">
            <dt>
              {k.split(' / ').map((x, i) => (
                <span key={i}>
                  {i > 0 && ' / '}
                  <kbd>{x}</kbd>
                </span>
              ))}
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3 className="section-label">About</h3>
      <p className="small">
        Your designs and your own parts and cables stay in this browser and in the files you save; nothing is sent anywhere.
        {REPOSITORY && (
          <>
            {' '}
            The source code is at{' '}
            <a href={REPOSITORY} target="_blank" rel="noreferrer">
              {REPOSITORY.replace(/^https?:\/\//, '')}
            </a>
            .
          </>
        )}
      </p>
    </Dialog>
  );
}
