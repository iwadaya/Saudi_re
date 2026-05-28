import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { SafeAreaView } from "react-native-safe-area-context";
import { getContract } from "@/api/contracts";
import { StatusBadge } from "@/components/StatusBadge";
import { ErrorBanner } from "@/components/ErrorBanner";
import { colors, radius, spacing } from "@/theme";
import { formatCompact, formatPct } from "@/util/format";

export default function ContractDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["contract", id],
    queryFn: () => getContract(id),
    enabled: !!id,
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  if (isError || !data) {
    return (
      <SafeAreaView style={styles.safe}>
        <ErrorBanner
          message={(error as Error)?.message ?? "Failed to load contract."}
          onRetry={refetch}
        />
      </SafeAreaView>
    );
  }

  const h = data.header;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.cedant}>{h.cedant_name ?? data.contract_id}</Text>
        <Text style={styles.sub}>
          {[h.treaty_type_name, h.country_name, h.uw_year].filter(Boolean).join(" · ")}
        </Text>
        <View style={{ marginTop: spacing.md }}>
          <StatusBadge status={h.status} />
        </View>

        <View style={styles.card}>
          <Row label="Cedant" value={h.cedant_name ?? "—"} />
          <Row label="Broker" value={h.broker_name ?? "—"} />
          <Row label="Country" value={h.country_name ?? "—"} />
          <Row label="Currency" value={h.currency_code ?? "—"} />
          <Row label="UW Year" value={h.uw_year != null ? String(h.uw_year) : "—"} />
          <Row label="Inception" value={h.inception_date ?? "—"} />
          <Row label="Renewal" value={h.renewal_date ?? "—"} />
          <Row
            label="Signed Line"
            value={h.signed_line_pct != null ? formatPct(h.signed_line_pct / 100) : "—"}
          />
        </View>

        {data.detail ? (
          <View style={styles.card}>
            <Row
              label="Total Capacity"
              value={data.detail.total_capacity != null ? formatCompact(data.detail.total_capacity) : "—"}
            />
            <Row
              label="QS EPI"
              value={data.detail.quota_share_epi != null ? formatCompact(data.detail.quota_share_epi) : "—"}
            />
            <Row
              label="Surplus EPI"
              value={data.detail.surplus_epi != null ? formatCompact(data.detail.surplus_epi) : "—"}
            />
            <Row
              label="Brokerage"
              value={data.detail.brokerage_pct != null ? formatPct(data.detail.brokerage_pct / 100) : "—"}
            />
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.darkBg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  cedant: { color: colors.white, fontSize: 22, fontWeight: "700" },
  sub: { color: colors.subtle, fontSize: 13, marginTop: 4 },
  card: {
    backgroundColor: colors.midBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.xl,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: { color: colors.subtle, fontSize: 13 },
  rowValue: {
    color: colors.white,
    fontSize: 13,
    fontWeight: "600",
    maxWidth: "60%",
  },
});
