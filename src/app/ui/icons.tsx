/**
 * The app's icons: simple 24 x 24 line drawings made for this app (no icon
 * package), drawn with the current text colour at a 1.75 stroke. Decorative
 * by default (`aria-hidden`); the control that holds one carries the name.
 */
import type { ReactNode, SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function make(name: string, body: ReactNode) {
  const Icon = ({ size = 16, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`icon icon-${name}`}
      {...rest}
    >
      {body}
    </svg>
  );
  Icon.displayName = `Icon(${name})`;
  return Icon;
}

/** The app's mark: a cable leaving a connector and turning through a bend. */
export const Logo = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" className="logo">
    <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--accent)" />
    <rect x="6" y="18" width="7" height="8" rx="1.5" fill="none" stroke="var(--on-accent)" strokeWidth="2" />
    <path d="M9.5 18 V13 a6 6 0 0 1 6 -6 H26" fill="none" stroke="var(--on-accent)" strokeWidth="2.6" strokeLinecap="round" />
    <circle cx="26" cy="7" r="2.2" fill="var(--on-accent)" />
  </svg>
);

export const IconSelect = make('select', <path d="M5 3l14 7-6 2-2 6z" />);
export const IconBrush = make(
  'brush',
  <>
    <path d="M14 4l6 6-8 8H6v-6z" />
    <path d="M11 7l6 6" />
  </>,
);
export const IconJoint = make(
  'joint',
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M4 20l5.8-5.8M14.2 9.8L20 4" />
    <path d="M17 4h3v3" />
  </>,
);
export const IconWire = make('wire', <path d="M3 18h4a4 4 0 0 0 4-4v-4a4 4 0 0 1 4-4h6" />);
export const IconUndo = make(
  'undo',
  <>
    <path d="M9 7L4 12l5 5" />
    <path d="M4 12h11a5 5 0 0 1 0 10h-3" />
  </>,
);
export const IconRedo = make(
  'redo',
  <>
    <path d="M15 7l5 5-5 5" />
    <path d="M20 12H9a5 5 0 0 0 0 10h3" />
  </>,
);
export const IconFolder = make('folder', <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />);
export const IconSave = make(
  'save',
  <>
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <path d="M4 19h16" />
  </>,
);
export const IconSun = make(
  'sun',
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </>,
);
export const IconMoon = make('moon', <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />);
export const IconHelp = make(
  'help',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2-2.4 3.6" />
    <path d="M12 17h.01" />
  </>,
);
export const IconChevronDown = make('chevron-down', <path d="M6 9l6 6 6-6" />);
export const IconChevronRight = make('chevron-right', <path d="M9 6l6 6-6 6" />);
export const IconChevronLeft = make('chevron-left', <path d="M15 6l-6 6 6 6" />);
export const IconModel = make(
  'model',
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </>,
);
export const IconArea = make(
  'area',
  <>
    <path d="M4 4h16v16H4z" strokeDasharray="3 3" />
    <path d="M8 8h8v8H8z" />
  </>,
);
export const IconPart = make(
  'part',
  <>
    <rect x="5" y="5" width="14" height="14" rx="1.5" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </>,
);
export const IconFit = make('fit', <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />);
export const IconGrid = make('grid', <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />);
export const IconEdges = make(
  'edges',
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" strokeDasharray="0" />
    <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" strokeDasharray="2 2.5" />
  </>,
);
export const IconCube = make(
  'cube',
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </>,
);
export const IconCheck = make('check', <path d="M5 12.5l4.5 4.5L19 7" />);
export const IconOk = make(
  'ok',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l3 3 5-6" />
  </>,
);
export const IconWarn = make(
  'warn',
  <>
    <path d="M12 3.5L22 20H2z" />
    <path d="M12 10v4.5M12 17.5h.01" />
  </>,
);
export const IconFail = make(
  'fail',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </>,
);
export const IconInfo = make(
  'info',
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v6M12 7.5h.01" />
  </>,
);
export const IconClose = make('close', <path d="M6 6l12 12M18 6L6 18" />);
export const IconPlus = make('plus', <path d="M12 5v14M5 12h14" />);
export const IconSearch = make(
  'search',
  <>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </>,
);
export const IconEdit = make('edit', <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />);
export const IconTrash = make('trash', <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />);
export const IconPanelLeft = make(
  'panel-left',
  <>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M9 4v16" />
  </>,
);
export const IconPanelRight = make(
  'panel-right',
  <>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M15 4v16" />
  </>,
);
export const IconExternal = make('external', <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />);
export const IconFile = make('file', <path d="M6 3h8l4 4v14H6zM14 3v4h4" />);
export const IconKeyboard = make(
  'keyboard',
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="1.5" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </>,
);
