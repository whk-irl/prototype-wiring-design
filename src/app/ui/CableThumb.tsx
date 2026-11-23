/** A cable type's thumbnail (drawn from its figures; see viewport/cableThumb.ts), requested once it scrolls into view. */
import { useEffect, useRef, useState } from 'react';
import type { CableType } from '@core';
import { cableThumbKey, cableThumbScene } from '../viewport/cableThumb';
import { requestObjectThumbnail } from '../viewport/thumbnails';

export function CableThumb({ type, size = 40 }: { type: CableType; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const key = cableThumbKey(type);
  useEffect(() => {
    if (!visible) return;
    setUrl(null);
    return requestObjectThumbnail(key, () => cableThumbScene(type), setUrl);
    // The key holds everything the picture depends on.
  }, [visible, key]);
  return (
    <span ref={ref} className="cable-thumb" style={{ width: size, height: size }} aria-hidden="true">
      {url && <img src={url} alt="" width={size} height={size} />}
    </span>
  );
}
