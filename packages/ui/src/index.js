/**
 * Components for both apps, on Android and iOS alike. Each one reads its colours, sizes and fonts from the theme in
 * the nearest ThemeProvider, so the owner app (the seller theme) and a shopper app (a brand kit's theme) share them.
 *
 * Rules for anything added here: only react-native's cross-platform primitives and the libraries in the app's
 * package.json; no colour, size or font written out (use the theme); every control at least `tap.min` high with an
 * accessibility role and label; no text that names a business or the platform (pass it in).
 */
import React, { createContext, useContext, useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text as NativeText, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { sellerTheme } from '@bhava/theme';

const ThemeContext = createContext(sellerTheme);

export function ThemeProvider({ theme = sellerTheme, children }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** Styles made from the theme once per theme: `const styles = useStyles((t) => ({ box: { padding: t.space[4] } }))`. */
export function useStyles(make) {
  const theme = useTheme();
  return useMemo(() => StyleSheet.create(make(theme)), [theme]); // eslint-disable-line react-hooks/exhaustive-deps
}

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

/** A whole screen: the ground colour, safe-area insets, and a scrolling body unless `scroll` is false (for lists). */
export function Screen({ title, scroll = true, header, footer, children, testID, contentStyle }) {
  const theme = useTheme();
  const padding = { paddingHorizontal: theme.space.gutter, paddingVertical: theme.space[4], gap: theme.space[4] };
  const heading = title ? <Text variant="page">{title}</Text> : null;
  return (
    <SafeAreaView testID={testID} style={{ flex: 1, backgroundColor: theme.color.ground }} edges={['top', 'left', 'right']}>
      {header}
      {scroll ? (
        <ScrollView contentContainerStyle={[padding, contentStyle]} keyboardShouldPersistTaps="handled">
          {heading}
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, padding, contentStyle]}>
          {heading}
          {children}
        </View>
      )}
      {footer}
    </SafeAreaView>
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

/** A surface that groups related things. */
export function Card({ children, style, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={[{ backgroundColor: theme.color.surface, borderRadius: theme.radius.card, borderWidth: 1, borderColor: theme.color.line, padding: theme.space[4], gap: theme.space[3] }, style]}>
      {children}
    </View>
  );
}

/** A message across the screen. `tone`: info, good, warn or bad. Read out as soon as it appears. */
export function Banner({ tone = 'info', title, children, action, testID }) {
  const theme = useTheme();
  const tones = {
    info: [theme.color.primaryTint, theme.color.primaryDeep],
    good: [theme.color.goodTint, theme.color.goodText],
    warn: [theme.color.accentTint, theme.color.accentText],
    bad: [theme.color.badTint, theme.color.badText],
  };
  const [bg, fg] = tones[tone] ?? tones.info;
  return (
    <View testID={testID} accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ backgroundColor: bg, borderRadius: theme.radius.tile, padding: theme.space[3], gap: theme.space[1] }}>
      {title ? <NativeText style={{ fontFamily: theme.font.bodySemiBold, fontSize: theme.text.small, color: fg }}>{title}</NativeText> : null}
      {children ? <NativeText style={{ fontFamily: theme.font.body, fontSize: theme.text.small, lineHeight: 20, color: fg }}>{children}</NativeText> : null}
      {action}
    </View>
  );
}

/** A labelled text field. `secret` hides what is typed and keeps it out of autofill and the keyboard's suggestions. */
export function Field({ label, value, onChangeText, error, hint, secret = false, testID, ...input }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[1] }}>
      <NativeText style={{ fontFamily: theme.font.bodyMedium, fontSize: theme.text.meta, color: theme.color.ink2 }}>{label}</NativeText>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onChangeText={onChangeText}
        placeholderTextColor={theme.color.ink3}
        secureTextEntry={secret}
        autoCorrect={secret ? false : input.autoCorrect}
        autoComplete={secret ? 'off' : input.autoComplete}
        {...input}
        style={{
          minHeight: theme.tap.large, borderRadius: theme.radius.field, borderWidth: 1, borderColor: error ? theme.color.badText : theme.color.line,
          backgroundColor: theme.color.surface, paddingHorizontal: theme.space[4], fontFamily: theme.font.body, fontSize: theme.text.body, color: theme.color.ink,
        }}
      />
      {error ? <NativeText accessibilityRole="alert" style={{ fontFamily: theme.font.body, fontSize: theme.text.meta, color: theme.color.badText }}>{error}</NativeText> : null}
      {!error && hint ? <NativeText style={{ fontFamily: theme.font.body, fontSize: theme.text.meta, color: theme.color.ink3 }}>{hint}</NativeText> : null}
    </View>
  );
}

/** One row of a list or a menu: a title, an optional line under it, and something at either end. */
export function ListRow({ title, subtitle, start, end, onPress, disabled = false, testID }) {
  const theme = useTheme();
  const body = (
    <>
      {start}
      <View style={{ flex: 1, gap: 2 }}>
        <NativeText numberOfLines={1} style={{ fontFamily: theme.font.bodySemiBold, fontSize: theme.text.body, color: theme.color.ink }}>{title}</NativeText>
        {subtitle ? <NativeText numberOfLines={2} style={{ fontFamily: theme.font.body, fontSize: theme.text.meta, color: theme.color.ink3 }}>{subtitle}</NativeText> : null}
      </View>
      {end}
    </>
  );
  const box = { minHeight: theme.tap.large, flexDirection: 'row', alignItems: 'center', gap: theme.space[3], paddingVertical: theme.space[2] };
  if (!onPress) return <View testID={testID} style={box}>{body}</View>;
  return (
    <Pressable testID={testID} onPress={disabled ? undefined : onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }} style={({ pressed }) => [box, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}>
      {body}
    </Pressable>
  );
}

/** A small label: a count or a status. `tone`: neutral, primary, good, warn or bad. */
export function Badge({ label, tone = 'neutral', testID }) {
  const theme = useTheme();
  const tones = {
    neutral: [theme.color.surfaceSunken, theme.color.ink2],
    primary: [theme.color.primaryTint, theme.color.primaryDeep],
    good: [theme.color.goodTint, theme.color.goodText],
    warn: [theme.color.accentTint, theme.color.accentText],
    bad: [theme.color.badTint, theme.color.badText],
  };
  const [bg, fg] = tones[tone] ?? tones.neutral;
  return (
    <View testID={testID} style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: theme.radius.pill, paddingHorizontal: theme.space[2], paddingVertical: 2 }}>
      <NativeText style={{ fontFamily: theme.font.bodySemiBold, fontSize: theme.text.caption, color: fg }}>{String(label)}</NativeText>
    </View>
  );
}

/** What a screen shows when there is nothing to list, or nothing built yet. */
export function EmptyState({ title, children, action, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ alignItems: 'center', gap: theme.space[2], paddingVertical: theme.space[8] }}>
      <Text variant="title" style={{ textAlign: 'center' }}>{title}</Text>
      {children ? <Text variant="small" style={{ textAlign: 'center' }}>{children}</Text> : null}
      {action}
    </View>
  );
}

/** A centred spinner with a label a screen reader says. */
export function Loading({ label, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessibilityRole="progressbar" accessibilityLabel={label} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.ground }}>
      <ActivityIndicator color={theme.color.primary} size="large" />
    </View>
  );
}

/** The round mark that shows which business the seller is working in: its logo, or its first letter. */
export function WorkspaceBadge({ name, logo, size = 36, testID }) {
  const theme = useTheme();
  const box = { width: size, height: size, borderRadius: size / 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.primaryTint };
  return (
    <View testID={testID} accessibilityRole="image" accessibilityLabel={name} style={box}>
      {logo ?? <NativeText style={{ fontFamily: theme.font.bodyBold, fontSize: size * 0.42, color: theme.color.primaryDeep }}>{String(name ?? '').trim().charAt(0).toUpperCase()}</NativeText>}
    </View>
  );
}
