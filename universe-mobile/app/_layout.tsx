import "react-native-gesture-handler";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryProvider } from "@/providers/QueryProvider";
import { AuthGate } from "@/providers/AuthGate";
import { colors } from "@/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryProvider>
        <AuthGate>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.darkBg },
              animation: "fade",
            }}
          >
            <Stack.Screen name="login" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen
              name="contract/[id]"
              options={{
                headerShown: true,
                headerTitle: "Contract",
                headerStyle: { backgroundColor: colors.headerBg },
                headerTintColor: colors.white,
                presentation: "card",
              }}
            />
          </Stack>
        </AuthGate>
      </QueryProvider>
    </SafeAreaProvider>
  );
}
