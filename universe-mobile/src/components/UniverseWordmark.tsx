import { Text, StyleSheet, type TextStyle } from "react-native";
import { colors } from "@/theme";

interface Props {
  size?: number;
  style?: TextStyle;
}

export function UniverseWordmark({ size = 16, style }: Props) {
  return (
    <Text style={[styles.text, { fontSize: size }, style]}>UNIVERSE</Text>
  );
}

const styles = StyleSheet.create({
  text: {
    color: colors.accent,
    fontWeight: "800",
    letterSpacing: 4,
  },
});
