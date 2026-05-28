import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuthStore } from "@/store/authStore";
import { UniverseWordmark } from "@/components/UniverseWordmark";
import { API_BASE } from "@/config";
import { colors, radius, spacing } from "@/theme";

export default function SettingsScreen() {
  const router = useRouter();
  const { userId, displayName, clear } = useAuthStore((s) => ({
    userId: s.userId,
    displayName: s.displayName,
    clear: s.clear,
  }));

  const onDisconnect = () => {
    clear();
    router.replace("/login");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.heading}>Settings</Text>
          <UniverseWordmark size={14} />
        </View>

        <Section title="Account">
          <Row label="User ID" value={userId || "—"} />
          <Row label="Display Name" value={displayName || "—"} />
        </Section>

        <Section title="Server">
          <Row label="API Base" value={API_BASE} />
          <Row label="Mode" value={__DEV__ ? "Development" : "Production"} />
        </Section>

        <Pressable style={styles.disconnect} onPress={onDisconnect}>
          <Text style={styles.disconnectText}>Disconnect</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  heading: { color: colors.white, fontSize: 22, fontWeight: "700" },
  section: { marginTop: spacing.lg },
  sectionTitle: {
    color: colors.subtle,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.midBg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
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
  disconnect: {
    marginTop: spacing.xxl,
    backgroundColor: colors.red,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  disconnectText: {
    color: colors.white,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
});
