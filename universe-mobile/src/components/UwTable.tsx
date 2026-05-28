import { useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, spacing } from "@/theme";
import type { PortfolioByUw } from "@/types/contract";
import { StatusBadge } from "./StatusBadge";
import { formatCompact, formatPct } from "@/util/format";

type SortKey = "uw_name" | "contract_count" | "total_epi" | "avg_tech_ratio";

interface Props {
  rows: PortfolioByUw[];
  onRowPress?: (uwId: string) => void;
}

export function UwTable({ rows, onRowPress }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("total_epi");
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return asc ? av - bv : bv - av;
      }
      return asc
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return arr;
  }, [rows, sortKey, asc]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setAsc((p) => !p);
    else {
      setSortKey(k);
      setAsc(false);
    }
  };

  const arrow = (k: SortKey) => {
    if (sortKey !== k) return null;
    return (
      <Feather
        name={asc ? "chevron-up" : "chevron-down"}
        size={11}
        color={colors.accent}
      />
    );
  };

  if (rows.length === 0) {
    return <Text style={styles.empty}>No underwriter data.</Text>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Pressable style={[styles.cell, styles.nameCell]} onPress={() => toggleSort("uw_name")}>
          <Text style={styles.headerText}>UW</Text>
          {arrow("uw_name")}
        </Pressable>
        <Pressable style={[styles.cell, styles.numCell]} onPress={() => toggleSort("contract_count")}>
          <Text style={styles.headerText}>#</Text>
          {arrow("contract_count")}
        </Pressable>
        <Pressable style={[styles.cell, styles.epiCell]} onPress={() => toggleSort("total_epi")}>
          <Text style={styles.headerText}>EPI</Text>
          {arrow("total_epi")}
        </Pressable>
        <Pressable style={[styles.cell, styles.numCell]} onPress={() => toggleSort("avg_tech_ratio")}>
          <Text style={styles.headerText}>RATIO</Text>
          {arrow("avg_tech_ratio")}
        </Pressable>
      </View>
      {sorted.map((row) => (
        <Pressable
          key={row.uw_id}
          style={styles.bodyRow}
          onPress={() => onRowPress?.(row.uw_id)}
        >
          <View style={[styles.cell, styles.nameCell]}>
            <Text style={styles.nameText} numberOfLines={1}>
              {row.uw_name}
            </Text>
            {row.status ? <StatusBadge status={row.status} /> : null}
          </View>
          <Text style={[styles.cell, styles.numCell, styles.valueText]}>
            {row.contract_count}
          </Text>
          <Text style={[styles.cell, styles.epiCell, styles.valueText]}>
            {formatCompact(row.total_epi)}
          </Text>
          <Text style={[styles.cell, styles.numCell, styles.valueText]}>
            {formatPct(row.avg_tech_ratio)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.lg,
  },
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
  },
  bodyRow: {
    flexDirection: "row",
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    alignItems: "center",
  },
  cell: {
    flexDirection: "row",
    alignItems: "center",
  },
  nameCell: {
    flex: 2,
  },
  numCell: {
    flex: 0.8,
    justifyContent: "flex-end",
  },
  epiCell: {
    flex: 1.2,
    justifyContent: "flex-end",
  },
  headerText: {
    color: colors.subtle,
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginRight: 2,
  },
  nameText: {
    color: colors.white,
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
    marginRight: spacing.sm,
  },
  valueText: {
    color: colors.white,
    fontSize: 13,
    textAlign: "right",
  },
  empty: {
    color: colors.subtle,
    paddingHorizontal: spacing.lg,
    fontSize: 13,
  },
});
