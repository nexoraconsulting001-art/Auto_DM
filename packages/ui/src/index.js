/**
 * Components for both apps, on Android and iOS alike. Each one reads its colours, sizes and fonts from the theme in
 * the nearest ThemeProvider, so the owner app (the seller theme) and a shopper app (a brand kit's theme) share them.
 *
 * Rules for anything added here: only react-native's cross-platform primitives and the libraries in the app's
 * package.json; no colour, size or font written out (use the theme); every control at least `tap.min` high with an
 * accessibility role and label; no text that names a business or the platform (pass it in).
 */
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text as NativeText, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Text } from './basics.js';
import { useTheme } from './theme-context.js';

// The rest of the kit lives beside this file, one subject per file, under the same rules.
export { ThemeProvider, useStyles, useTheme } from './theme-context.js';
export { Choices, IconButton, Toggle } from './controls.js';
export { ConfirmSheet, Sheet } from './sheet.js';
export { Divider, ErrorState, ListState, LoadingRows, Section } from './states.js';
export { BarChart, ProgressRing, Sparkline, barLayout, ringDash, sparklinePath } from './charts.js';
export { Button, Text };

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

/**
 * One row of a list or a menu: a title, an optional line under it, and something at either end. A screen reader hears
 * the title and the line together when the row can be tapped (`accessibilityLabel` replaces both), and `emphasis`
 * marks an unread row in bold.
 */
export function ListRow({ title, subtitle, start, end, onPress, disabled = false, emphasis = false, accessibilityLabel, accessibilityHint, testID }) {
  const theme = useTheme();
  const body = (
    <>
      {start}
      <View style={{ flex: 1, gap: 2 }}>
        <NativeText numberOfLines={1} style={{ fontFamily: emphasis ? theme.font.bodyBold : theme.font.bodySemiBold, fontSize: theme.text.body, color: theme.color.ink }}>{title}</NativeText>
        {subtitle ? <NativeText numberOfLines={2} style={{ fontFamily: theme.font.body, fontSize: theme.text.meta, color: theme.color.ink3 }}>{subtitle}</NativeText> : null}
      </View>
      {end}
    </>
  );
  const box = { minHeight: theme.tap.large, flexDirection: 'row', alignItems: 'center', gap: theme.space[3], paddingVertical: theme.space[2] };
  const spoken = accessibilityLabel ?? [title, subtitle].filter(Boolean).join(', ');
  // A row with no action of its own stays open to a screen reader, so a button at its end can still be reached.
  if (!onPress) return <View testID={testID} style={box}>{body}</View>;
  return (
    <Pressable testID={testID} onPress={disabled ? undefined : onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={spoken} accessibilityHint={accessibilityHint} accessibilityState={{ disabled }} style={({ pressed }) => [box, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}>
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
