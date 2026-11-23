/**
 * The bytes the app writes must reopen. `serializeForSave` produces the exact
 * text of design.json and round-trips it through the same parser and
 * validation that Open project uses; it refuses if that fails.
 */
import { parseDesign, type ConnectorLibrary, type Design, type Library } from '@core';

export type SaveResult = { ok: true; text: string } | { ok: false; errors: string[] };

export function serializeForSave(design: Design, library: Library | null | undefined, connectors?: ConnectorLibrary | null): SaveResult {
  let text: string;
  try {
    text = `${JSON.stringify(design, null, 2)}\n`;
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const parsed = parseDesign(JSON.parse(text), library ?? undefined, connectors ?? undefined);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.issues.filter((i) => i.severity === 'error').map((i) => `${i.path || '(file)'}: ${i.message}`) };
  }
  return { ok: true, text };
}
