import { useEffect } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  interpolate,
} from "react-native-reanimated";
import { colors, radius } from "@/theme";

interface Props {
  height?: number;
  width?: number | string;
  style?: ViewStyle;
}

export function Skeleton({ height = 16, width = "100%", style }: Props) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true
    );
  }, [progress]);

  const animated = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.45, 1]),
  }));

  return (
    <View
      style={[
        styles.base,
        { height, width: width as ViewStyle["width"] },
        style,
      ]}
    >
      <Animated.View style={[styles.fill, animated]} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.midBg,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  fill: {
    flex: 1,
    backgroundColor: colors.border,
  },
});
