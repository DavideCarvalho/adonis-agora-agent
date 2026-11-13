import type { ReactNode, SVGProps } from 'react';

/**
 * The agent console's own 16px stroke glyphs (nav + brand mark), drawn like the kit's icons. The
 * kit's shared ones (Activity, Grid, Clock, Settings, …) are imported from `agora-kit/icons`.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function glyph(paths: ReactNode) {
  // biome-ignore lint/correctness/noComponentHookFactories: a static icon table built once at module load, no hooks inside
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

/** The brand mark: the agent glyph (a small robot head). */
export const AgentMark = glyph(
  <>
    <rect x="2.5" y="5" width="11" height="8" rx="2" />
    <path d="M8 2.5V5M6 8.5v1M10 8.5v1M1 8.5v2M15 8.5v2" />
  </>,
);

/** Reliability: a pulse inside a shield. */
export const ShieldPulseIcon = glyph(
  <>
    <path d="M8 1.75 2.75 3.75v4c0 3.1 2.2 5.6 5.25 6.5 3.05-.9 5.25-3.4 5.25-6.5v-4z" />
    <path d="M5 8h1.5l1-2 1.5 4 1-2H11" />
  </>,
);

/** Threads: a speech bubble. */
export const ThreadIcon = glyph(<path d="M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z M5 6.5h6M5 8.5h4" />);

/** Tool calls: a wrench. */
export const WrenchIcon = glyph(
  <path d="M10.5 2a3 3 0 0 0-2.8 4.1L2.5 11.3a1.3 1.3 0 0 0 1.8 1.8l5.2-5.2A3 3 0 0 0 13.6 5l-1.9 1.9-1.6-.4-.4-1.6L11.6 3A3 3 0 0 0 10.5 2z" />,
);

/** Generative UI: sparkles. */
export const SparklesIcon = glyph(
  <>
    <path d="M6.5 2.5 7.6 5.4l2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9-2.9-1.1 2.9-1.1z" />
    <path d="M12 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
  </>,
);

/** Approvals: a check in a circle. */
export const ApprovalIcon = glyph(
  <>
    <circle cx="8" cy="8" r="5.75" />
    <path d="m5.5 8.2 1.7 1.7 3.3-3.6" />
  </>,
);

/** Quota: a gauge. */
export const GaugeIcon = glyph(
  <>
    <path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" />
    <path d="M8 11.5 10.5 7" />
    <circle cx="8" cy="11.5" r="0.6" />
  </>,
);

/** Tools (per-tool stats): a toolbox. */
export const ToolboxIcon = glyph(
  <>
    <rect x="2" y="5" width="12" height="8" rx="1.5" />
    <path d="M6 5V3.5h4V5M2 8.5h12M7 8.5v1.5h2V8.5" />
  </>,
);

/** Pricing: a price tag. */
export const TagIcon = glyph(
  <>
    <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
    <circle cx="5.5" cy="5.5" r="1" />
  </>,
);

/** Calendar (topbar date range). */
export const CalendarIcon = glyph(
  <>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </>,
);
