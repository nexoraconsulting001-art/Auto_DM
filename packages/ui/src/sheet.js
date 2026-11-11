/**
 * A sheet that rises from the bottom over the screen, for a choice or a short task (confirm a revoke, enter a code).
 * Built on react-native's Modal, so it is the same on Android and iOS: the back button and a tap outside close it,
 * and a screen reader stays inside it while it is open. Words are passed in; nothing here names anyone.
 */
import React from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import X from 'lucide-react-native/icons/x';
import { Button, Text } from './basics.js';
import { IconButton } from './controls.js';
import { useTheme } from './theme-context.js';

/**
 * `visible` and `onClose` are the caller's state. `closeLabel` is what the close button says to a screen reader; with
 * `dismissable` false (while something is being saved) neither the cross, the back button nor a tap outside closes it.
 */
export function Sheet({ visible, onClose, title, closeLabel, children, footer, dismissable = true, testID }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const close = dismissable ? onClose : undefined;
  return (
    <Modal visible={Boolean(visible)} transparent animationType="slide" onRequestClose={() => close?.()} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          testID={testID ? `${testID}-backdrop` : undefined}
          onPress={close}
          accessible={false}
          importantForAccessibility="no"
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.color.ink, opacity: 0.4 }}
        />
        <View
          testID={testID}
          accessibilityViewIsModal
          style={{
            backgroundColor: theme.color.surface, borderTopLeftRadius: theme.radius.card, borderTopRightRadius: theme.radius.card,
            paddingHorizontal: theme.space.gutter, paddingTop: theme.space[4], paddingBottom: Math.max(insets.bottom, theme.space[4]), gap: theme.space[4], maxHeight: '88%',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
            <Text variant="title" style={{ flex: 1 }}>{title}</Text>
            {dismissable && closeLabel ? <IconButton testID={testID ? `${testID}-close` : undefined} tone="quiet" label={closeLabel} onPress={onClose} icon={<X color={theme.color.ink2} size={20} />} /> : null}
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: theme.space[3] }}>{children}</ScrollView>
          {footer ? <View style={{ gap: theme.space[2] }}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * "Are you sure?" for something that cannot be undone. `tone` danger makes the confirm button red. While `busy`, the
 * sheet stays open and both buttons wait.
 */
export function ConfirmSheet({ visible, title, children, confirmLabel, cancelLabel, onConfirm, onCancel, busy = false, tone = 'danger', disabled = false, testID }) {
  return (
    <Sheet
      visible={visible}
      onClose={onCancel}
      title={title}
      closeLabel={cancelLabel}
      dismissable={!busy}
      testID={testID}
      footer={
        <>
          <Button testID={testID ? `${testID}-confirm` : undefined} kind={tone === 'danger' ? 'danger' : 'primary'} label={confirmLabel} onPress={onConfirm} busy={busy} disabled={disabled} />
          <Button testID={testID ? `${testID}-cancel` : undefined} kind="quiet" label={cancelLabel} onPress={onCancel} disabled={busy} />
        </>
      }
    >
      {typeof children === 'string' ? <Text variant="small">{children}</Text> : children}
    </Sheet>
  );
}
