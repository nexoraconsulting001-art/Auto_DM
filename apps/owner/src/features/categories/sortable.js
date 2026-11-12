/**
 * A row that can be dragged up or down by its handle, and moved one place with its two arrow buttons (the arrows are
 * what a screen reader and a switch user use; the drag is the quick way). The row moves under the finger while it is
 * held; on release the list is told where it lands (indexAfterDrag in sequence.js) and decides what to do.
 */
import React, { useMemo, useRef } from 'react';
import { Animated, PanResponder, View } from 'react-native';
import GripVertical from 'lucide-react-native/icons/grip-vertical';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import ArrowDown from 'lucide-react-native/icons/arrow-down';
import { IconButton, useTheme } from '@bhava/ui';
import { indexAfterDrag } from './sequence.js';

export const ROW_HEIGHT = 72;

export function SortableRow({ index, count, onMove, disabled = false, labels, testID, children }) {
  const theme = useTheme();
  const dy = useRef(new Animated.Value(0)).current;
  const height = useRef(ROW_HEIGHT); // measured, so a taller row still lands where the finger left it
  const live = useRef({ index, count, onMove, disabled });
  live.current = { index, count, onMove, disabled };
  const responder = useMemo(
    () => PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.disabled,
      onMoveShouldSetPanResponder: (_e, g) => !live.current.disabled && Math.abs(g.dy) > 4,
      onPanResponderMove: Animated.event([null, { dy }], { useNativeDriver: false }),
      onPanResponderRelease: (_e, g) => {
        const { index: from, count: n, onMove: move } = live.current;
        dy.setValue(0);
        const to = indexAfterDrag(from, g.dy, height.current, n);
        if (to !== from) move(from, to);
      },
      onPanResponderTerminate: () => dy.setValue(0),
    }),
    [dy],
  );
  return (
    <Animated.View testID={testID} onLayout={(e) => { height.current = e.nativeEvent.layout.height || ROW_HEIGHT; }} style={{ minHeight: ROW_HEIGHT, flexDirection: 'row', alignItems: 'center', gap: theme.space[2], transform: [{ translateY: dy }] }}>
      <View
        {...responder.panHandlers}
        testID={testID ? `${testID}-handle` : undefined}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
        style={{ width: theme.tap.min, minHeight: theme.tap.min, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}
      >
        <GripVertical color={theme.color.ink3} size={20} />
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      <IconButton testID={testID ? `${testID}-up` : undefined} tone="quiet" label={labels.up} disabled={disabled || index === 0} onPress={() => onMove(index, index - 1)} icon={<ArrowUp color={theme.color.ink2} size={18} />} />
      <IconButton testID={testID ? `${testID}-down` : undefined} tone="quiet" label={labels.down} disabled={disabled || index >= count - 1} onPress={() => onMove(index, index + 1)} icon={<ArrowDown color={theme.color.ink2} size={18} />} />
    </Animated.View>
  );
}
