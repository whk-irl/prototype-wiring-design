/**
 * Tool registry. `store.activeTool` names the active tool; the viewport host
 * calls `bindTools` once so changes to it reach the viewport.
 */
import { useApp } from '../state/store';
import type { Viewport } from '../viewport/Viewport';
import { axisTool } from './axisTool';
import { placeTool } from './placeTool';
import { portTool } from './portTool';
import { wireTool } from './wireTool';
import { selectTool } from './selectTool';
import type { Tool } from './types';
import { zoneTool } from './zoneTool';

const tools = new Map<string, Tool>([selectTool, zoneTool, placeTool, axisTool, wireTool, portTool].map((t) => [t.id, t]));

export function registerTool(tool: Tool): void {
  tools.set(tool.id, tool);
}

export function getTool(id: string): Tool {
  return tools.get(id) ?? selectTool;
}

/** Keep the viewport's tool in sync with the store. Returns an unsubscribe. */
export function bindTools(viewport: Viewport): () => void {
  viewport.setTool(getTool(useApp.getState().activeTool));
  return useApp.subscribe((s, prev) => {
    if (s.activeTool !== prev.activeTool) viewport.setTool(getTool(s.activeTool));
  });
}

export type { Tool, ToolContext, ToolPointerEvent, RayHit } from './types';
