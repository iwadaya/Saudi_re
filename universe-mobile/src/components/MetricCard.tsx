import { View, Text, StyleSheet } from "react-native";
import { colors, text, radius, spacing } from "@/theme";

interface Props {
  label: string;
  value: string;
  subValue?: string;
  trend?: "up" | "down" | "flat";
  accentColor?: string;
  minWidth?: number;
}

export function MetricCard({
  label,
  value,
  subValue,
  trend,
  accentColor = colors.accent,
  minWidth = 160,
}: Props) {
  return (
    <View style={[styles.card, { borderTopColor: accentColor, minWidth }]}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
      {subValue ? (
        <Text style={[styles.sub, trend === "down" && { color: colors.red }, trend === "up" && { color: colors.accent }]}>
          {subValue}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.midBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopWidth: 3,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginRight: spacing.md,
  },
  label: {
    ...text.label,
    marginBottom: spacing.sm,
  },
  value: {
    ...text.metric,
  },
  sub: {
    ...text.caption,
    marginTop: spacing.xs,
  },
});
