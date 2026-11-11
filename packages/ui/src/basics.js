/** Text and Button: what nearly every other component is made of, kept apart so the others can import them. */
import React from 'react';
import { ActivityIndicator, Pressable, Text as NativeText } from 'react-native';
import { useTheme } from './theme-context.js';

const TEXT_VARIANTS = {
  page: (t) => ({ fontFamily: t.font.display, fontSize: t.text.page, lineHeight: 32, color: t.color.ink }),
  title: (t) => ({ fontFamily: t.font.bodySemiBold, fontSize: t.text.title, lineHeight: 24, color: t.color.ink }),
  body: (t) => ({ fontFamily: t.font.body, fontSize: t.text.body, lineHeight: 22, color: t.color.ink }),
  small: (t) => ({ fontFamily: t.font.body, fontSize: t.text.small, lineHeight: 20, color: t.color.ink2 }),
  meta: (t) => ({ fontFamily: t.font.bodyMedium, fontSize: t.text.meta, lineHeight: 18, color: t.color.ink3 }),
  caption: (t) => ({ fontFamily: t.font.bodyMedium, fontSize: t.text.caption, lineHeight: 16, color: t.color.ink3 }),
};

/** Text in one of the theme's sizes. `tone`: ink, muted, good, bad, primary, onPrimary, onInk. */
export function Text({ variant = 'body', tone, style, children, ...rest }) {
  const theme = useTheme();
  const tones = { ink: theme.color.ink, muted: theme.color.ink3, good: theme.color.goodText, bad: theme.color.badText, primary: theme.color.primary, onPrimary: theme.color.onPrimary, onInk: theme.color.onInk };
  const base = (TEXT_VARIANTS[variant] ?? TEXT_VARIANTS.body)(theme);
  return (
    <NativeText accessibilityRole={variant === 'page' || variant === 'title' ? 'header' : undefined} {...rest} style={[base, tone ? { color: tones[tone] ?? base.color } : null, style]}>
      {children}
    </NativeText>
  );
}

/** A button. `kind`: primary, secondary, quiet or danger. `busy` shows a spinner and ignores taps, as `disabled` does. */
export function Button({ label, onPress, kind = 'primary', disabled = false, busy = false, icon, testID, style, accessibilityHint }) {
  const theme = useTheme();
  const off = disabled || busy;
  const kinds = {
    primary: { bg: theme.color.primary, fg: theme.color.onPrimary, border: theme.color.primary },
    secondary: { bg: theme.color.surface, fg: theme.color.ink, border: theme.color.line },
    quiet: { bg: 'transparent', fg: theme.color.primary, border: 'transparent' },
    danger: { bg: theme.color.badTint, fg: theme.color.badText, border: theme.color.badTint },
  };
  const look = kinds[kind] ?? kinds.primary;
  return (
    <Pressable
      testID={testID}
      onPress={off ? undefined : onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [
        { minHeight: theme.tap.large, borderRadius: theme.radius.field, paddingHorizontal: theme.space[5], backgroundColor: look.bg, borderColor: look.border, borderWidth: 1 },
        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.space[2], opacity: off ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={look.fg} /> : icon}
      <NativeText style={{ fontFamily: theme.font.bodySemiBold, fontSize: theme.text.body, color: look.fg }}>{label}</NativeText>
    </Pressable>
  );
}
