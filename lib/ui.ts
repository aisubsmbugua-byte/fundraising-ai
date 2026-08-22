// Shared style tokens, sourced from the design-review handoff
// (design-tokens.css / DESIGN-HANDOFF.md). Existing key names are
// kept even where the underlying hex changed, so this stays a
// values-only swap -- every page already styles itself through these
// tokens rather than ad-hoc hex codes, which is what makes that
// possible.

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const colors = {
  // Core semantic tokens (existing call sites, new values).
  text: "#101c2f",
  textMuted: "#66758b",
  textFaint: "#8b96a8",
  border: "#d8e0ea",
  borderStrong: "#b8c4d3",
  bgSubtle: "#f5f7fa",
  primary: "#0b1f3a",
  primaryText: "#fff",
  // Amber, not red -- red is reserved for permanent destructive
  // actions (see buttonDanger). A pending-review badge isn't
  // dangerous, it's a due-soon/attention signal.
  danger: "#d9363e",
  success: "#087a67",
  warning: "#b96805",

  // New tokens the redesign introduces directly.
  canvas: "#faf9f6",
  surface: "#ffffff",
  surfaceSubtle: "#f5f7fa",
  navy950: "#071b36",
  navy900: "#0b1f3a",
  navy700: "#29415f",
  navy500: "#526985",
  teal700: "#087a67",
  teal100: "#e5f4f0",
  amber700: "#b96805",
  amber100: "#fff3dd",
  red600: "#d9363e",
  red100: "#fdebec",
  focus: "#2563eb",
} as const;

export const font = {
  // Applied via next/font/google in app/layout.tsx; this is the CSS
  // variable it exposes, for anywhere that needs to reference it
  // outside the body-level default (e.g. an isolated widget).
  sans: "var(--font-inter), ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
} as const;

export const type = {
  display: 34,
  pageTitle: 30,
  sectionTitle: 19,
  subsectionTitle: 17,
  cardTitle: 16,
  bodyLg: 16,
  body: 14,
  meta: 12.5,
} as const;

export const radius = 8;
export const radiusSm = 6;
export const radiusLg = 10;
export const radiusPill = 999;

export const shadow = {
  card: "0 1px 2px rgba(7, 27, 54, 0.06)",
  raised: "0 8px 24px rgba(7, 27, 54, 0.10)",
  dialog: "0 20px 50px rgba(7, 27, 54, 0.18)",
  focusRing: "0 0 0 3px rgba(37, 99, 235, 0.28)",
} as const;

// Every text input, select, and textarea should use this (or spread
// it) -- box-sizing: border-box is load-bearing, without it padding
// pushes elements past width: 100% and breaks alignment.
export const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: spacing.sm,
  marginTop: spacing.xs,
  border: `1px solid ${colors.border}`,
  borderRadius: radiusSm,
  fontSize: type.body,
  boxSizing: "border-box",
  fontFamily: "inherit",
};

export const labelStyle: React.CSSProperties = {
  fontSize: type.meta,
  color: colors.textMuted,
  display: "block",
};

export const buttonPrimary: React.CSSProperties = {
  padding: "10px 16px",
  background: colors.primary,
  color: colors.primaryText,
  border: "none",
  borderRadius: radiusSm,
  cursor: "pointer",
  fontSize: type.body,
  fontWeight: 600,
};

export const buttonSecondary: React.CSSProperties = {
  padding: "10px 16px",
  background: colors.surface,
  color: colors.text,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radiusSm,
  cursor: "pointer",
  fontSize: type.body,
  fontWeight: 500,
  textDecoration: "none",
  display: "inline-block",
};

export const buttonDanger: React.CSSProperties = {
  padding: "6px 12px",
  background: colors.surface,
  color: colors.red600,
  border: `1px solid ${colors.red600}`,
  borderRadius: radiusSm,
  cursor: "pointer",
  fontSize: 13,
};

export const sectionStyle: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: radius,
  padding: spacing.lg,
  display: "grid",
  gap: spacing.md,
  boxSizing: "border-box",
  background: colors.surface,
};

export const cardStyle: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: radiusSm,
  padding: spacing.md,
  background: colors.surface,
  boxSizing: "border-box",
  boxShadow: shadow.card,
};

// A tinted chip -- status pills, tier badges, review-needed counts.
// Pairs a light background with its matching dark-on-light text so
// meaning never rides on hue alone (still pair with a label/icon per
// the handoff's accessibility guidance -- this covers the color half).
export function chipStyle(tone: "teal" | "amber" | "red" | "neutral"): React.CSSProperties {
  const map = {
    teal: { bg: colors.teal100, fg: colors.teal700 },
    amber: { bg: colors.amber100, fg: colors.amber700 },
    red: { bg: colors.red100, fg: colors.red600 },
    neutral: { bg: colors.surfaceSubtle, fg: colors.textMuted },
  } as const;
  const { bg, fg } = map[tone];
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: radiusPill,
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    color: fg,
  };
}
