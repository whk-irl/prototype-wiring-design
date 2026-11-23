/** Status shown three ways at once: icon, colour and word (the word may be visually hidden but is always there for screen readers). */
import type { ReactNode } from 'react';
import { IconFail, IconInfo, IconOk, IconWarn } from './icons';

export type Verdict = 'ok' | 'warn' | 'fail' | 'info' | 'checking' | 'unknown';

const WORD: Record<Verdict, string> = { ok: 'OK', warn: 'Warning', fail: 'Fails', info: 'Note', checking: 'Checking', unknown: 'Not checked' };

export function StatusIcon({ verdict, size = 14, label }: { verdict: Verdict; size?: number; label?: string }) {
  const icon =
    verdict === 'ok' ? <IconOk size={size} /> : verdict === 'warn' ? <IconWarn size={size} /> : verdict === 'fail' ? <IconFail size={size} /> : <IconInfo size={size} />;
  return (
    <span className={`status-icon ${verdict}`} role="img" aria-label={label ?? WORD[verdict]} title={label ?? WORD[verdict]}>
      {icon}
    </span>
  );
}

/** A check result: icon, the verdict with its numbers in one line, and the explanation (sources, lists) in an expander. */
export function CheckRow({ verdict, title, summary, children, defaultOpen = false }: { verdict: Verdict; title: string; summary: ReactNode; children?: ReactNode; defaultOpen?: boolean }) {
  const head = (
    <>
      <StatusIcon verdict={verdict} />
      <span className="check-title">{title}</span>
      <span className="check-summary">{summary}</span>
    </>
  );
  if (!children)
    return (
      <div className={`check-row ${verdict}`}>
        <div className="check-head">{head}</div>
      </div>
    );
  return (
    <details className={`check-row ${verdict}`} open={defaultOpen}>
      <summary className="check-head">
        {head}
        <span className="chev" aria-hidden="true" />
      </summary>
      <div className="check-body">{children}</div>
    </details>
  );
}

/** A small tag: confidence, source, "yours". */
export function Tag({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'fail'; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} title={title}>
      {children}
    </span>
  );
}
