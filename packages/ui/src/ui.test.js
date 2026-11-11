import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { fromBrandKit, sellerTheme } from '@bhava/theme';
import { Badge, Banner, Button, EmptyState, Field, ListRow, Text, ThemeProvider, WorkspaceBadge } from './index.js';

const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

test('a button is at least a full tap target and says what it is', async () => {
  const onPress = jest.fn();
  await render(<Button label="Confirm" onPress={onPress} testID="go" />);
  const button = screen.getByRole('button', { name: 'Confirm' });
  expect(flat(button.props.style).minHeight).toBeGreaterThanOrEqual(sellerTheme.tap.min);
  await fireEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('a disabled or busy button ignores taps and tells assistive tech', async () => {
  const onPress = jest.fn();
  await render(
    <>
      <Button label="Confirm" onPress={onPress} disabled />
      <Button label="Saving" onPress={onPress} busy />
    </>,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Saving' }));
  expect(onPress).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Confirm' }).props.accessibilityState.disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Saving' }).props.accessibilityState.busy).toBe(true);
});

test('components take their colours from the theme they are given', async () => {
  const brand = fromBrandKit({ colors: { primary: '#0a7a55', ground: '#fffaf0', ink: '#221100' } });
  await render(
    <ThemeProvider theme={brand}>
      <Text testID="copy">Hello</Text>
      <Button label="Buy" onPress={() => {}} />
    </ThemeProvider>,
  );
  expect(flat(screen.getByTestId('copy').props.style).color).toBe('#221100');
  expect(flat(screen.getByRole('button', { name: 'Buy' }).props.style).backgroundColor).toBe('#0a7a55');
});

test('a field shows its error, and a secret field hides what is typed', async () => {
  const onChangeText = jest.fn();
  await render(<Field label="Key secret" value="" onChangeText={onChangeText} error="Required" secret testID="secret" />);
  const input = screen.getByTestId('secret');
  expect(input.props.secureTextEntry).toBe(true);
  expect(input.props.autoComplete).toBe('off');
  expect(screen.getByText('Required')).toBeTruthy();
  await fireEvent.changeText(input, 'abc');
  expect(onChangeText).toHaveBeenCalledWith('abc');
});

test('rows, banners, badges and empty states render what they are given', async () => {
  const onPress = jest.fn();
  await render(
    <>
      <Banner tone="warn" title="Offline" testID="banner">Showing saved rows.</Banner>
      <ListRow title="Orders" subtitle="3 to confirm" onPress={onPress} testID="row" end={<Badge label={3} tone="primary" />} />
      <EmptyState title="Nothing here yet">Add your first one.</EmptyState>
      <WorkspaceBadge name="acme" testID="badge" />
    </>,
  );
  expect(screen.getByTestId('banner').props.accessibilityRole).toBe('alert');
  await fireEvent.press(screen.getByTestId('row'));
  expect(onPress).toHaveBeenCalled();
  expect(screen.getByText('3')).toBeTruthy();
  expect(screen.getByText('Nothing here yet')).toBeTruthy();
  expect(screen.getByText('A')).toBeTruthy();
});

test('no component writes a colour out or uses a platform-only module', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(source.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  expect(source).not.toMatch(/ToastAndroid|PermissionsAndroid|BackHandler|DrawerLayoutAndroid|ActionSheetIOS|DatePickerIOS|\.android\b|\.ios\b/);
});
