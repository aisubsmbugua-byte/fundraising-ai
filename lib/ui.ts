// Shared style tokens. Functionality comes first in this build, but
// basic consistency (spacing, alignment, box-sizing) should hold even
// before a dedicated design pass -- see CLAUDE.md's design principle.
// Use these instead of ad-hoc inline styles so pages stay on a
// consistent grid.

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const colors = {
  text: "#0f172a",
  textMuted: "#64748b",
  textFaint: "#94a3b8",
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  bgSubtle: "#f8fafc",
  primary: "#0f172a",
  primaryText: "#fff",
  danger: "#dc2626",
  success: "#16a34a",
  warning: "#d97706",
} as const;

export const radius = 6;

// Every text input, select, and textarea should use this (or spread
// it) -- box-sizing: border-box is load-bearing, without it padding
// pushes elements past width: 100% and breaks alignment.
export const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: spacing.sm,
  marginTop: spacing.xs,
  border: `1px solid ${colors.border}`,
  borderRadius: radius,
  fontSize: 14,
  boxSizing: "border-box",
  fontFamily: "inherit",
};

export const labelStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.textMuted,
  display: "block",
};

export const buttonPrimary: React.CSSProperties = {
  padding: "10px 16px",
  background: colors.primary,
  color: colors.primaryText,
  border: "none",
  borderRadius: radius,
  cursor: "pointer",
  fontSize: 14,
};

export const buttonSecondary: React.CSSProperties = {
  padding: "10px 16px",
  background: "#fff",
  color: colors.text,
  border: `1px solid ${colors.borderStrong}`,
  borderRadius: radius,
  cursor: "pointer",
  fontSize: 14,
  textDecoration: "none",
  display: "inline-block",
};

export const buttonDanger: React.CSSProperties = {
  padding: "6px 12px",
  background: "#fff",
  color: colors.danger,
  border: `1px solid ${colors.danger}`,
  borderRadius: radius,
  cursor: "pointer",
  fontSize: 13,
};

export const sectionStyle: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: 8,
  padding: spacing.lg,
  display: "grid",
  gap: spacing.md,
  boxSizing: "border-box",
};

export const cardStyle: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  borderRadius: radius,
  padding: spacing.md,
  background: "#fff",
  boxSizing: "border-box",
};
