import { View, Text, StyleSheet } from "react-native";
import { colors, text } from "@/theme";
import type { ContractStatus } from "@/types/contract";

interface Props {
  status: ContractStatus | string;
}

function colorFor(status: string): { bg: string; fg: string } {
  switch (status) {
    case "QUOTED":
      return { bg: "#2A4A6B", fg: colors.subtle };
    case "AWAITING_APPROVAL":
    case "PENDING_APPROVAL":
      return { bg: colors.gold + "33", fg: colors.gold };
    case "APPROVED":
      return { bg: colors.accent + "33", fg: colors.accent };
    case "BOUND":
    case "SIGNED":
    case "AWAITING_SIGNED_LINE":
      return { bg: colors.blue + "33", fg: colors.blue };
    case "DECLINED":
    case "NTU":
    case "CANCELLED":
      return { bg: colors.red + "33", fg: colors.red };
    case "DRAFT":
    default:
      return { bg: "#2A4A6B", fg: colors.subtle };
  }
}

export function StatusBadge({ status }: Props) {
  const { bg, fg } = colorFor(status);
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.label, { color: fg }]}>{status.replace(/_/g, " ")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  label: {
    ...text.badge,
  },
});
