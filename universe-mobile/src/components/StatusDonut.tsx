import { View, Text, StyleSheet } from "react-native";
import Svg, { Circle, G } from "react-native-svg";
import { colors, spacing } from "@/theme";
import type { PortfolioByStatus } from "@/types/contract";

interface Props {
  data: PortfolioByStatus[];
  size?: number;
  strokeWidth?: number;
}

const STATUS_COLORS: Record<string, string> = {
  QUOTED: colors.subtle,
  AWAITING_APPROVAL: colors.gold,
  PENDING_APPROVAL: colors.gold,
  APPROVED: colors.accent,
  BOUND: colors.blue,
  SIGNED: colors.blue,
  AWAITING_SIGNED_LINE: colors.blue,
  DECLINED: colors.red,
  NTU: colors.red,
  CANCELLED: colors.red,
  DRAFT: "#5A6B82",
  OFFERED: colors.gold,
  RENEWED: colors.accent,
};

export function StatusDonut({ data, size = 180, strokeWidth = 20 }: Props) {
  const total = data.reduce((s, d) => s + d.count, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return <Text style={styles.empty}>No status data.</Text>;
  }

  let offset = 0;

  return (
    <View style={styles.container}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={colors.midBg}
              strokeWidth={strokeWidth}
              fill="transparent"
            />
            {data.map((d) => {
              const frac = d.count / total;
              const dash = circumference * frac;
              const stroke = STATUS_COLORS[d.status] ?? colors.subtle;
              const c = (
                <Circle
                  key={d.status}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={-offset}
                  fill="transparent"
                  strokeLinecap="butt"
                />
              );
              offset += dash;
              return c;
            })}
          </G>
        </Svg>
        <View style={[styles.centerLabel, { width: size, height: size }]}>
          <Text style={styles.centerNumber}>{total}</Text>
          <Text style={styles.centerCaption}>Total</Text>
        </View>
      </View>
      <View style={styles.legend}>
        {data.map((d) => {
          const stroke = STATUS_COLORS[d.status] ?? colors.subtle;
          const pct = ((d.count / total) * 100).toFixed(0);
          return (
            <View key={d.status} style={styles.legendRow}>
              <View style={[styles.swatch, { backgroundColor: stroke }]} />
              <Text style={styles.legendStatus} numberOfLines={1}>
                {d.status.replace(/_/g, " ")}
              </Text>
              <Text style={styles.legendValue}>
                {d.count} · {pct}%
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  centerLabel: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
  },
  centerNumber: {
    color: colors.white,
    fontSize: 26,
    fontWeight: "700",
  },
  centerCaption: {
    color: colors.subtle,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  legend: {
    flex: 1,
    marginLeft: spacing.lg,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 3,
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 2,
    marginRight: spacing.sm,
  },
  legendStatus: {
    flex: 1,
    color: colors.white,
    fontSize: 11,
    fontWeight: "600",
  },
  legendValue: {
    color: colors.subtle,
    fontSize: 11,
  },
  empty: {
    color: colors.subtle,
    paddingHorizontal: spacing.lg,
    fontSize: 13,
  },
});
