import { View, Text, Pressable, StyleSheet } from "react-native";
import { colors, radius, spacing } from "@/theme";

interface Props {
  message: string;
  onRetry?: () => void;
}

export function ErrorBanner({ message, onRetry }: Props) {
  return (
    <View style={styles.banner}>
      <Text style={styles.message} numberOfLines={3}>
        {message}
      </Text>
      {onRetry ? (
        <Pressable onPress={onRetry} style={styles.retry} hitSlop={8}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    margin: spacing.lg,
    padding: spacing.lg,
    backgroundColor: colors.red + "22",
    borderColor: colors.red,
    borderWidth: 1,
    borderRadius: radius.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  message: {
    flex: 1,
    color: colors.red,
    fontSize: 13,
    marginRight: spacing.md,
  },
  retry: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.red,
  },
  retryText: {
    color: colors.white,
    fontWeight: "700",
    fontSize: 12,
  },
});
