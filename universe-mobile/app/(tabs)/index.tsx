import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { getPortfolioStats } from "@/api/contracts";
import { useAuthStore } from "@/store/authStore";
import { UniverseWordmark } from "@/components/UniverseWordmark";
import { MetricCard } from "@/components/MetricCard";
import { SectionHeader } from "@/components/SectionHeader";
import { UwTable } from "@/components/UwTable";
import { RegionBars } from "@/components/RegionBars";
import { StatusDonut } from "@/components/StatusDonut";
import { ActivityFeed } from "@/components/ActivityFeed";
import { Skeleton } from "@/components/Skeleton";
import { ErrorBanner } from "@/components/ErrorBanner";
import { colors, spacing } from "@/theme";
import { formatCompact, formatPct, formatDate, greeting } from "@/util/format";

export default function DashboardScreen() {
  const router = useRouter();
  const displayName = useAuthStore((s) => s.displayName);
  const today = new Date();

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ["portfolioStats"],
    queryFn: getPortfolioStats,
    staleTime: 5 * 60_000,
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={refetch}
            tintColor={colors.accent}
          />
        }
      >
        {/* HEADER STRIP */}
        <View style={styles.headerStrip}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greeting}>
              {greeting(today)}, {displayName || "there"}
            </Text>
            <Text style={styles.dateText}>{formatDate(today.toISOString())}</Text>
          </View>
          <UniverseWordmark size={14} />
        </View>

        {isError ? (
          <ErrorBanner
            message={(error as Error)?.message ?? "Failed to load dashboard."}
            onRetry={refetch}
          />
        ) : null}

        {/* KPI ROW */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.kpiRow}
        >
          {isLoading ? (
            <>
              <Skeleton width={160} height={100} style={styles.kpiSkeleton} />
              <Skeleton width={160} height={100} style={styles.kpiSkeleton} />
              <Skeleton width={160} height={100} style={styles.kpiSkeleton} />
              <Skeleton width={160} height={100} style={styles.kpiSkeleton} />
            </>
          ) : (
            <>
              <MetricCard
                label="Total EPI"
                value={formatCompact(data?.total_epi ?? 0)}
              />
              <MetricCard
                label="Active Contracts"
                value={String(data?.active_contracts ?? 0)}
                accentColor={colors.blue}
              />
              <MetricCard
                label="Pending Approvals"
                value={String(data?.pending_approvals ?? 0)}
                accentColor={colors.gold}
              />
              <MetricCard
                label="Avg Tech Ratio"
                value={formatPct(data?.avg_tech_ratio ?? 0)}
                accentColor={colors.accent}
              />
            </>
          )}
        </ScrollView>

        <Divider />

        {/* BY UNDERWRITER */}
        <SectionHeader title="By Underwriter" />
        {isLoading ? (
          <View style={styles.skeletonBlock}>
            <Skeleton height={18} />
            <Skeleton height={18} style={{ marginTop: 10 }} />
            <Skeleton height={18} style={{ marginTop: 10 }} />
          </View>
        ) : (
          <UwTable
            rows={data?.by_uw ?? []}
            onRowPress={(uwId) =>
              router.push({ pathname: "/(tabs)/contracts", params: { uwId } })
            }
          />
        )}

        <Divider />

        {/* BY REGION */}
        <SectionHeader title="By Region" />
        {isLoading ? (
          <View style={styles.skeletonBlock}>
            <Skeleton height={14} />
            <Skeleton height={14} style={{ marginTop: 8 }} />
            <Skeleton height={14} style={{ marginTop: 8 }} />
          </View>
        ) : (
          <RegionBars regions={data?.by_region ?? []} />
        )}

        <Divider />

        {/* BY STATUS */}
        <SectionHeader title="By Status" />
        {isLoading ? (
          <View style={styles.skeletonBlock}>
            <Skeleton height={140} />
          </View>
        ) : (
          <StatusDonut data={data?.by_status ?? []} />
        )}

        <Divider />

        {/* RECENT ACTIVITY */}
        <SectionHeader title="Recent Activity" />
        {isLoading ? (
          <View style={styles.skeletonBlock}>
            <Skeleton height={48} />
            <Skeleton height={48} style={{ marginTop: 8 }} />
            <Skeleton height={48} style={{ marginTop: 8 }} />
          </View>
        ) : (
          <ActivityFeed items={data?.recent_activity ?? []} />
        )}

        <View style={{ height: spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.darkBg },
  scroll: { flex: 1 },
  content: { paddingBottom: spacing.xl },
  headerStrip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  greeting: {
    color: colors.white,
    fontSize: 22,
    fontWeight: "700",
  },
  dateText: {
    color: colors.subtle,
    fontSize: 12,
    marginTop: 4,
  },
  kpiRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  kpiSkeleton: {
    marginRight: spacing.md,
  },
  skeletonBlock: {
    paddingHorizontal: spacing.lg,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
    marginHorizontal: spacing.lg,
    opacity: 0.4,
  },
});
