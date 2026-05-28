export const colors = {
  darkBg: "#0D1B2A",
  midBg: "#132338",
  headerBg: "#1A3A5C",
  accent: "#00C8A0",
  gold: "#F5A623",
  white: "#FFFFFF",
  subtle: "#C8D6E5",
  red: "#E05252",
  border: "#2A4A6B",
  blue: "#3B82F6",
} as const;

export const text = {
  hero: { fontSize: 28, fontWeight: "700" as const, color: colors.white },
  title: { fontSize: 20, fontWeight: "600" as const, color: colors.white },
  body: { fontSize: 14, fontWeight: "400" as const, color: colors.white },
  metric: { fontSize: 24, fontWeight: "700" as const, color: colors.white },
  label: {
    fontSize: 11,
    fontWeight: "600" as const,
    color: colors.subtle,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
  },
  caption: { fontSize: 12, fontWeight: "400" as const, color: colors.subtle },
  badge: {
    fontSize: 10,
    fontWeight: "700" as const,
    letterSpacing: 0.6,
    textTransform: "uppercase" as const,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 18,
} as const;
