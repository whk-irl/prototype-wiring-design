import { useEffect, useRef } from 'react';
import { bindTools } from '../tools';
import { Viewport } from '../viewport/Viewport';
import { setViewport } from '../viewport/instance';

/** Mounts the imperative three.js viewport into the layout. */
export function ViewportHost({ onReady }: { onReady?: (v: Viewport) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const viewport = new Viewport(el);
    setViewport(viewport);
    const unbind = bindTools(viewport);
    onReadyRef.current?.(viewport);
    return () => {
      unbind();
      setViewport(null);
      viewport.dispose();
    };
  }, []);

  return <div ref={ref} className="viewport-mount" />;
}
