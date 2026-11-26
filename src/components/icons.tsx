/**
 * White line icons, inlined as SVG.
 *
 * Deliberately not an icon package: the widget needs a handful of glyphs, and
 * an inline <svg> adds no dependency, no extra request and no extra JS. Every
 * icon paints with `currentColor`, so the toolbar's text colour drives them and
 * hover states recolour them for free.
 *
 * Glyphs and stroke widths follow the original ToolbarWidget reference.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Create / edit - page with a pencil. */
export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </Icon>
  );
}

/** To-do - tick. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <polyline points="20 6 9 17 4 12" />
    </Icon>
  );
}

/** Notifications - bell. */
export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </Icon>
  );
}

/** Plus, for the create panel's leading button. */
export function PlusIcon(props: IconProps) {
  return (
    <Icon size={16} {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Icon>
  );
}

/** Up arrow, for submitting the create input. */
export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon size={16} {...props}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </Icon>
  );
}

/** Close, for panel headers. */
export function CloseIcon(props: IconProps) {
  return (
    <Icon size={14} {...props}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </Icon>
  );
}

/** Remove completed tasks from the checklist. */
export function TrashIcon(props: IconProps) {
  return (
    <Icon size={14} {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
      <path d="M9 6V4h6v2" />
    </Icon>
  );
}

/**
 * Recently completed tasks, kept for 24 hours and restorable.
 *
 * A clock with a counterclockwise sweep back to it, rather than an eye. The eye
 * says "look at this"; what the panel actually offers is "go back in time to
 * this" - the row is stamped with when it was done and carries an undo - so the
 * history glyph describes the action instead of the panel.
 */
export function HistoryIcon(props: IconProps) {
  return (
    <Icon size={15} {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </Icon>
  );
}

/** Undo completion and return a task to the active checklist. */
export function UndoIcon(props: IconProps) {
  return (
    <Icon size={14} {...props}>
      <path d="M3 7v5h5" />
      <path d="M4.5 12a8 8 0 1 0 2-5.5L3 12" />
    </Icon>
  );
}
