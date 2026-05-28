import { View, Text, Pressable, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { colors, spacing } from "@/theme";
import type { ContractListItem } from "@/types/contract";
import { StatusBadge } from "./StatusBadge";
import { timeAgo } from "@/util/format";

interface Props {
  items: ContractListItem[];
}

export function ActivityFeed({ items }: Props) {
  const router = useRouter();
  if (items.length === 0) {
    return <Text style={styles.empty}>No recent activity.</Text>;
  }
  return (
    <View style={styles.container}>
      {items.map((c) => (
        <Pressable
          key={c.contract_id}
          style={styles.row}
          onPress={() => router.push(`/contract/${c.contract_id}`)}
        >
          <View style={styles.main}>
            <Text style={styles.title} numberOfLines={1}>
              {c.cedant_name ?? c.contract_id}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {[c.treaty_type_name, c.country_name, c.uw_year]
                .filter((x) => x != null && x !== "")
                .join(" · ")}
            </Text>
          </View>
          <View style={styles.right}>
            <StatusBadge status={c.status} />
            <Text style={styles.time}>{timeAgo(c.updated_at)}</Text>
          </View>
        </Pressable>
      ))}
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
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  main: {
    flex: 1,
    marginRight: spacing.md,
  },
  title: {
    color: colors.white,
    fontSize: 14,
    fontWeight: "600",
  },
  sub: {
    color: colors.subtle,
    fontSize: 12,
    marginTop: 2,
  },
  right: {
    alignItems: "flex-end",
  },
  time: {
    color: colors.subtle,
    fontSize: 11,
    marginTop: 4,
  },
  empty: {
    color: colors.subtle,
    paddingHorizontal: spacing.lg,
    fontSize: 13,
  },
});
