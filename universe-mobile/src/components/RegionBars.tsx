import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius } from "@/theme";
import type { PortfolioByRegion } from "@/types/contract";
import { formatCompact } from "@/util/format";

interface Props {
  regions: PortfolioByRegion[];
}

export function RegionBars({ regions }: Props) {
  if (regions.length === 0) {
    return <Text style={styles.empty}>No region data.</Text>;
  }
  const max = Math.max(...regions.map((r) => r.total_epi), 1);
  const top = regions[0]?.region;

  return (
    <View style={styles.container}>
      {regions.slice(0, 8).map((r) => {
        const pct = (r.total_epi / max) * 100;
        const isTop = r.region === top;
        return (
          <View key={r.region} style={styles.row}>
            <Text style={styles.label} numberOfLines={1}>
              {r.region}
            </Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  {
                    width: `${Math.max(pct, 2)}%`,
                    backgroundColor: isTop ? colors.gold : colors.accent,
                  },
                ]}
              />
            </View>
            <Text style={styles.value}>{formatCompact(r.total_epi)}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 5,
  },
  label: {
    width: 90,
    color: colors.subtle,
    fontSize: 12,
  },
  track: {
    flex: 1,
    height: 10,
    backgroundColor: colors.midBg,
    borderRadius: radius.sm,
    marginHorizontal: spacing.md,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: radius.sm,
  },
  value: {
    width: 64,
    textAlign: "right",
    color: colors.white,
    fontSize: 12,
    fontWeight: "600",
  },
  empty: {
    color: colors.subtle,
    paddingHorizontal: spacing.lg,
    fontSize: 13,
  },
});
