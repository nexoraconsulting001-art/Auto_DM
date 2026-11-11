/**
 * What a screen shows while it waits, when something failed, and when there is nothing yet; and the plain pieces a
 * list is made of. Words come from the caller.
 */
import React from 'react';
import { View } from 'react-native';
import { Button, Text } from './basics.js';
import { useTheme } from './theme-context.js';

/** Something did not load. `onRetry` adds the button; `retryLabel` is its words. Read out as soon as it appears. */
export function ErrorState({ title, children, onRetry, retryLabel, busy = false, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ alignItems: 'center', gap: theme.space[2], paddingVertical: theme.space[8] }}>
      <Text variant="title" tone="bad" style={{ textAlign: 'center' }}>{title}</Text>
      {children ? <Text variant="small" style={{ textAlign: 'center' }}>{children}</Text> : null}
      {onRetry && retryLabel ? <Button testID={testID ? `${testID}-retry` : undefined} kind="secondary" label={retryLabel} onPress={onRetry} busy={busy} /> : null}
    </View>
  );
}

/** Grey rows in the shape of the list that is on its way. `label` is what a screen reader hears ("Loading"). */
export function LoadingRows({ rows = 3, label, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }} style={{ gap: theme.space[3] }}>
      {Array.from({ length: Math.max(1, Math.min(rows, 12)) }, (_, i) => (
        <View key={i} style={{ minHeight: theme.tap.large, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
          <View style={{ width: 36, height: 36, borderRadius: theme.radius.pill, backgroundColor: theme.color.surfaceSunken }} />
          <View style={{ flex: 1, gap: theme.space[2] }}>
            <View style={{ height: 12, width: `${70 - ((i * 13) % 30)}%`, borderRadius: theme.radius.small, backgroundColor: theme.color.surfaceSunken }} />
            <View style={{ height: 10, width: '40%', borderRadius: theme.radius.small, backgroundColor: theme.color.lineSoft }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * The one of four a list is in: loading (nothing yet), failed (nothing to show and an error), empty, or its rows.
 * Saved rows shown while offline count as rows: an error with rows in hand shows the rows, and the screen's
 * offline banner says why they may be old.
 *
 *   <ListState loading={q.isPending} error={q.error} empty={!items.length} loadingLabel={t('common.loading')}
 *              errorTitle={t('error.title')} onRetry={q.refetch} retryLabel={t('common.retry')} emptyView={<EmptyState ... />}>
 *     {items.map(...)}
 *   </ListState>
 */
export function ListState({ loading, error, empty, children, loadingLabel, errorTitle, errorBody, onRetry, retryLabel, emptyView, testID }) {
  if (loading) return <LoadingRows label={loadingLabel} testID={testID ? `${testID}-loading` : undefined} />;
  if (error && empty) return <ErrorState testID={testID ? `${testID}-error` : undefined} title={errorTitle} onRetry={onRetry} retryLabel={retryLabel}>{errorBody}</ErrorState>;
  if (empty) return emptyView ?? null;
  return <>{children}</>;
}

/** A group on a screen with a heading, and something at the heading's end (a "See all" or a count). */
export function Section({ title, action, children, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2], minHeight: theme.tap.min }}>
          <Text variant="title" style={{ flex: 1 }}>{title}</Text>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

/** A hairline between rows. */
export function Divider() {
  const theme = useTheme();
  return <View importantForAccessibility="no" accessibilityElementsHidden style={{ height: 1, backgroundColor: theme.color.lineSoft }} />;
}
