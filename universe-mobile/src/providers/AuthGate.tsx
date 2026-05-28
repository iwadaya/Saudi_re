import { useEffect, type ReactNode } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter, useSegments } from "expo-router";
import { useAuthStore } from "@/store/authStore";
import { colors } from "@/theme";

interface Props {
  children: ReactNode;
}

export function AuthGate({ children }: Props) {
  const router = useRouter();
  const segments = useSegments();
  const userId = useAuthStore((s) => s.userId);
  const hydrated = useAuthStore((s) => s.hydrated);

  useEffect(() => {
    if (!hydrated) return;
    const onLogin = segments[0] === "login";
    if (!userId && !onLogin) {
      router.replace("/login");
    } else if (userId && onLogin) {
      router.replace("/(tabs)");
    }
  }, [hydrated, userId, segments, router]);

  if (!hydrated) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  loader: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.darkBg,
  },
});
