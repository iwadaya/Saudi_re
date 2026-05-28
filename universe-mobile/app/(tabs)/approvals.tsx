import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, spacing } from "@/theme";

export default function ApprovalsScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.container}>
        <Feather name="check-circle" size={48} color={colors.gold} />
        <Text style={styles.title}>Approvals</Text>
        <Text style={styles.subtitle}>Coming in Phase 3</Text>
        <Text style={styles.body}>
          Review pending treaties, approve or decline with notes from your
          phone.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.darkBg },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  title: {
    color: colors.white,
    fontSize: 22,
    fontWeight: "700",
    marginTop: spacing.lg,
  },
  subtitle: {
    color: colors.gold,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    marginTop: spacing.sm,
  },
  body: {
    color: colors.subtle,
    textAlign: "center",
    marginTop: spacing.md,
    fontSize: 13,
    maxWidth: 260,
  },
});
