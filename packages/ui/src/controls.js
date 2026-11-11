/**
 * Controls beside Button and Field: an icon-only button, an on/off row, and a row of choices. Same rules as
 * index.js: theme values only, cross-platform primitives only, every control at least `tap.min` in both directions
 * with a role and a label that a screen reader says.
 */
import React from 'react';
import { Pressable, Switch, Text as NativeText, View } from 'react-native';
import { useTheme } from './theme-context.js';

/**
 * A button that is only an icon, such as the bell or a close cross. `label` is required: it is all a screen reader
 * has. `count` draws a small badge (the unread count); above 99 it reads 99+.
 */
export function IconButton({ icon, label, onPress, count, disabled = false, tone = 'plain', testID, style }) {
  const theme = useTheme();
  if (!label) throw new Error('IconButton needs a label for screen readers');
  const tones = {
    plain: { bg: theme.color.surface, border: theme.color.line },
    quiet: { bg: 'transparent', border: 'transparent' },
  };
  const look = tones[tone] ?? tones.plain;
  const shown = Number.isInteger(count) && count > 0 ? (count > 99 ? '99+' : String(count)) : null;
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        { minWidth: theme.tap.min, minHeight: theme.tap.min, borderRadius: theme.radius.tile, backgroundColor: look.bg, borderColor: look.border, borderWidth: 1 },
        { alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      {icon}
      {shown ? (
        <View
          testID={testID ? `${testID}-count` : undefined}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={{ position: 'absolute', top: 4, right: 4, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: theme.radius.pill, backgroundColor: theme.color.badText, alignItems: 'center', justifyContent: 'center' }}
        >
          <NativeText style={{ fontFamily: theme.font.bodyBold, fontSize: 10, color: theme.color.onPrimary }}>{shown}</NativeText>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * A setting that is on or off: a title, a line under it, and a switch. The whole row toggles, so the target is the
 * row and not the small switch. `locked` shows the value and cannot be changed (a security notice).
 */
export function Toggle({ title, subtitle, value, onValueChange, disabled = false, testID }) {
  const theme = useTheme();
  const off = disabled || !onValueChange;
  const flip = () => {
    if (!off) onValueChange(!value);
  };
  return (
    <Pressable
      testID={testID}
      onPress={off ? undefined : flip}
      disabled={off}
      accessibilityRole="switch"
      accessibilityLabel={title}
      accessibilityHint={subtitle}
      accessibilityState={{ checked: Boolean(value), disabled: off }}
      style={{ minHeight: theme.tap.large, flexDirection: 'row', alignItems: 'center', gap: theme.space[3], paddingVertical: theme.space[2], opacity: off ? 0.6 : 1 }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <NativeText style={{ fontFamily: theme.font.bodySemiBold, fontSize: theme.text.body, color: theme.color.ink }}>{title}</NativeText>
        {subtitle ? <NativeText style={{ fontFamily: theme.font.body, fontSize: theme.text.meta, color: theme.color.ink3 }}>{subtitle}</NativeText> : null}
      </View>
      <Switch
        testID={testID ? `${testID}-switch` : undefined}
        value={Boolean(value)}
        onValueChange={off ? undefined : onValueChange}
        disabled={off}
        importantForAccessibility="no"
        accessibilityElementsHidden
        trackColor={{ false: theme.color.line, true: theme.color.primary }}
        thumbColor={theme.color.surface}
        ios_backgroundColor={theme.color.line}
      />
    </Pressable>
  );
}

/**
 * One choice from a few, such as English or Hindi. `options` is [{ value, label }]. Each choice is a radio button
 * a screen reader can tell apart.
 */
export function Choices({ options, value, onChange, disabled = false, label, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            testID={testID ? `${testID}-${option.value}` : undefined}
            onPress={disabled || chosen ? undefined : () => onChange(option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: chosen, disabled }}
            style={{
              minHeight: theme.tap.min, minWidth: theme.tap.min, paddingHorizontal: theme.space[4], borderRadius: theme.radius.pill, borderWidth: 1,
              borderColor: chosen ? theme.color.primary : theme.color.line, backgroundColor: chosen ? theme.color.primaryTint : theme.color.surface,
              alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1,
            }}
          >
            <NativeText style={{ fontFamily: theme.font.bodySemiBold, fontSize: theme.text.small, color: chosen ? theme.color.primaryDeep : theme.color.ink2 }}>{option.label}</NativeText>
          </Pressable>
        );
      })}
    </View>
  );
}
