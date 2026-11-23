import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installModalFocus } from './ui/modalFocus';
import { App } from './App';
import { watchComponentWarnings } from './placement/checks';
import { watchWireChecks } from './wires/run';
import { loadUserParts } from './userParts/actions';
import { loadUserCables } from './userCables/actions';
import { onDbStatus } from './parts/store';
import { useApp } from './state/store';
import { watchDesignIntegrity } from './state/integrity';
import { loadBundledCableLibrary, loadBundledConnectorLibrary, loadBundledLibrary, watchRuntimeLibrary } from './state/library';
import './styles.css';
import { initTheme } from './ui/theme';

initTheme();

loadBundledConnectorLibrary();
loadBundledLibrary();
watchRuntimeLibrary();
loadBundledCableLibrary();
watchDesignIntegrity();
watchComponentWarnings();
watchWireChecks();
// The parts and cables kept on this PC. If another tab holds an older version of the storage open, say so;
// the lists load by themselves once that tab lets go (the open is only held up, not failed).
let wasBlocked = false;
onDbStatus((status, detail) => {
  if (status === 'blocked') {
    wasBlocked = true;
    useApp.getState().notify('warning', 'Your own parts and cables are waiting for another tab', [detail]);
  } else if (status === 'open' && wasBlocked) {
    wasBlocked = false;
    useApp.getState().notify('info', 'Your own parts and cables are loaded', ['The other tab let go of the storage.']);
  }
});
void loadUserParts();
void loadUserCables();

installModalFocus();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
