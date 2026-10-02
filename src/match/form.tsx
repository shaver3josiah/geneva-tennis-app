import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { color, radius, semantic } from '../theme';

/** A labelled text field, the same shape as the roster's. */
export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & Omit<TextInputProps, 'style' | 'placeholderTextColor'>) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={f.label}>{label}</Text>
      <TextInput
        style={f.input}
        placeholderTextColor={color.textFaint}
        accessibilityLabel={label}
        accessibilityHint={hint}
        autoCorrect={false}
        {...input}
      />
      {hint ? <Text style={f.hint}>{hint}</Text> : null}
    </View>
  );
}

/** One choice among a few that wrap onto lines: a roster name, a court position. */
export function Chip({
  label,
  spoken,
  selected,
  onPress,
}: {
  label: string;
  /** What a screen reader says, when the visible label leans on its group ("#1"). */
  spoken?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={spoken ?? label}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [f.chip, selected && f.chipOn, pressed && !selected && { backgroundColor: color.inkHover }]}
    >
      <Text style={[f.chipText, selected && f.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export const FieldLabel = ({ children }: { children: string }) => <Text style={f.label}>{children}</Text>;

const f = StyleSheet.create({
  label: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: color.textFaint,
    marginBottom: 6,
  },
  input: {
    backgroundColor: semantic.surfaceInput,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    borderRadius: radius.input,
    color: color.chalk,
    fontSize: 15,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  hint: { fontSize: 12, lineHeight: 17, color: color.textDim, marginTop: 5 },
  chip: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: semantic.borderStrong,
    backgroundColor: semantic.surfaceCard,
  },
  // Text on a gold fill is night, never white: white on gold is 2.8:1.
  chipOn: { backgroundColor: color.gold, borderColor: color.gold },
  chipText: { fontSize: 13.5, fontWeight: '700', color: color.textLede },
  chipTextOn: { color: color.night },
});
