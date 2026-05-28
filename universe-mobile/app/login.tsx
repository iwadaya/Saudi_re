import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuthStore } from "@/store/authStore";
import { UniverseWordmark } from "@/components/UniverseWordmark";
import { colors, radius, spacing } from "@/theme";

export default function LoginScreen() {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const [userId, setUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = () => {
    const id = userId.trim();
    const name = displayName.trim();
    if (id.length === 0 || name.length === 0) {
      setError("User ID and Display Name are required.");
      return;
    }
    setUser(id, name, name);
    router.replace("/(tabs)");
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.headerBlock}>
          <UniverseWordmark size={22} />
          <Text style={styles.tagline}>Reinsurance Platform</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.title}>Connect to Universe</Text>
          <Text style={styles.subtitle}>
            Authentication uses your existing Universe user identifier.
          </Text>

          <Text style={styles.label}>User ID</Text>
          <TextInput
            style={styles.input}
            value={userId}
            onChangeText={setUserId}
            placeholder="e.g. iwa"
            placeholderTextColor={colors.subtle + "99"}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>Display Name</Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="e.g. Ishe Wa"
            placeholderTextColor={colors.subtle + "99"}
            autoCorrect={false}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable style={styles.button} onPress={onSubmit}>
            <Text style={styles.buttonText}>Connect to Universe</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.darkBg },
  container: { flex: 1, justifyContent: "center", padding: spacing.xl },
  headerBlock: { alignItems: "center", marginBottom: spacing.xxl },
  tagline: {
    color: colors.subtle,
    marginTop: spacing.sm,
    fontSize: 12,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  card: {
    backgroundColor: colors.midBg,
    borderRadius: radius.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { color: colors.white, fontSize: 20, fontWeight: "700" },
  subtitle: {
    color: colors.subtle,
    fontSize: 13,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  label: {
    color: colors.subtle,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.darkBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    color: colors.white,
    fontSize: 15,
  },
  error: {
    color: colors.red,
    marginTop: spacing.md,
    fontSize: 13,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md + 2,
    alignItems: "center",
    marginTop: spacing.xl,
  },
  buttonText: {
    color: colors.darkBg,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.6,
  },
});
