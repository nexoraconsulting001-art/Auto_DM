import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { Text as NativeText, processColor } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { fromBrandKit, hitSlopFor, sellerTheme } from '@bhava/theme';
import {
  BarChart, Choices, ConfirmSheet, ErrorState, IconButton, ListRow, ListState, LoadingRows, ProgressRing, Section, Sheet, Sparkline, ThemeProvider, Toggle,
  barLayout, ringDash, sparklinePath,
} from './index.js';

const flat = (style) => Object.assign({}, ...[typeof style === 'function' ? style({ pressed: false }) : style].flat(Infinity).filter(Boolean));
const Icon = () => <NativeText>i</NativeText>;

describe('controls', () => {
  test('an icon button is a full tap target both ways, says what it does, and shows a capped count', async () => {
    const onPress = jest.fn();
    await render(<IconButton testID="bell" label="Notifications, 120 new" icon={<Icon />} count={120} onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Notifications, 120 new' });
    expect(flat(button.props.style).minHeight).toBeGreaterThanOrEqual(sellerTheme.tap.min);
    expect(flat(button.props.style).minWidth).toBeGreaterThanOrEqual(sellerTheme.tap.min);
    expect(screen.getByText('99+', { includeHiddenElements: true })).toBeTruthy(); // the label already says the number
    await fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test('an icon button with no label is refused, because a screen reader would have nothing to say', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(render(<IconButton icon={<Icon />} onPress={() => {}} />)).rejects.toThrow(/needs a label/);
    console.error.mockRestore();
  });

  test('a toggle row is a switch to assistive tech, flips from anywhere on the row, and a locked one cannot change', async () => {
    const onValueChange = jest.fn();
    await render(
      <>
        <Toggle testID="push" title="Push" subtitle="On this phone" value={false} onValueChange={onValueChange} />
        <Toggle testID="security" title="New sign-ins" value disabled onValueChange={onValueChange} />
      </>,
    );
    const row = screen.getByTestId('push');
    expect(row.props.accessibilityRole).toBe('switch');
    expect(row.props.accessibilityState).toEqual({ checked: false, disabled: false });
    expect(flat(row.props.style).minHeight).toBeGreaterThanOrEqual(sellerTheme.tap.min);
    await fireEvent.press(row);
    expect(onValueChange).toHaveBeenCalledWith(true);
    await fireEvent.press(screen.getByTestId('security'));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('security').props.accessibilityState).toEqual({ checked: true, disabled: true });
  });

  test('choices are radio buttons and only an unchosen one calls back', async () => {
    const onChange = jest.fn();
    await render(<Choices testID="lang" label="Language" value="en" onChange={onChange} options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिन्दी' }]} />);
    expect(screen.getByTestId('lang-en').props.accessibilityState.checked).toBe(true);
    await fireEvent.press(screen.getByTestId('lang-en'));
    await fireEvent.press(screen.getByTestId('lang-hi'));
    expect(onChange.mock.calls).toEqual([['hi']]);
    expect(flat(screen.getByTestId('lang-hi').props.style).minHeight).toBeGreaterThanOrEqual(sellerTheme.tap.min);
  });

  test('a list row reads its title and its line together', async () => {
    await render(<ListRow testID="row" title="Pixel 8" subtitle="Android · this phone" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Pixel 8, Android · this phone' })).toBeTruthy();
  });

  test('a small control is given the hit area it lacks', () => {
    expect(hitSlopFor(32)).toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
    expect(hitSlopFor(44)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(hitSlopFor(20, 44)).toEqual({ top: 0, bottom: 0, left: 12, right: 12 });
  });
});

describe('sheets', () => {
  test('a sheet shows its title and closes from its cross; one that is saving cannot be closed', async () => {
    const onClose = jest.fn();
    const { rerender } = await render(<Sheet testID="sheet" visible title="Sign out this phone?" closeLabel="Close" onClose={onClose}><NativeText>Body</NativeText></Sheet>);
    expect(screen.getByText('Sign out this phone?')).toBeTruthy();
    expect(screen.getByTestId('sheet').props.accessibilityViewIsModal).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    await fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await rerender(<Sheet testID="sheet" visible title="Saving" closeLabel="Close" onClose={onClose} dismissable={false} />);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    await fireEvent.press(screen.getByTestId('sheet-backdrop', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('a hidden sheet draws nothing', async () => {
    await render(<Sheet visible={false} title="Hidden" closeLabel="Close" onClose={() => {}} />);
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  test('a confirm sheet confirms or cancels, and while busy it only waits', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const props = { visible: true, title: 'Remove?', confirmLabel: 'Remove', cancelLabel: 'Keep', onConfirm, onCancel, testID: 'confirm' };
    const { rerender } = await render(<ConfirmSheet {...props}>This cannot be undone.</ConfirmSheet>);
    expect(screen.getByText('This cannot be undone.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('confirm-confirm'));
    await fireEvent.press(screen.getByTestId('confirm-cancel'));
    expect([onConfirm.mock.calls.length, onCancel.mock.calls.length]).toEqual([1, 1]);
    await rerender(<ConfirmSheet {...props} busy>Saving</ConfirmSheet>);
    await fireEvent.press(screen.getByTestId('confirm-confirm'));
    await fireEvent.press(screen.getByTestId('confirm-cancel'));
    expect([onConfirm.mock.calls.length, onCancel.mock.calls.length]).toEqual([1, 1]);
  });
});

describe('states', () => {
  test('an error says so out loud and retries; loading rows say they are loading', async () => {
    const onRetry = jest.fn();
    await render(
      <>
        <ErrorState testID="err" title="That didn’t load" onRetry={onRetry} retryLabel="Try again">Check your connection.</ErrorState>
        <LoadingRows testID="wait" rows={4} label="Loading" />
      </>,
    );
    expect(screen.getByTestId('err').props.accessibilityRole).toBe('alert');
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
    expect(screen.getByTestId('wait').props.accessibilityLabel).toBe('Loading');
    expect(screen.getByTestId('wait').props.accessibilityState).toEqual({ busy: true });
  });

  test('a list is loading, failed, empty or its rows, and rows in hand win over an error', async () => {
    const common = { loadingLabel: 'Loading', errorTitle: 'Failed', retryLabel: 'Try again', onRetry: () => {}, emptyView: <NativeText>Nothing yet</NativeText>, testID: 'list' };
    const rows = <NativeText>Row 1</NativeText>;
    const { rerender } = await render(<ListState {...common} loading empty>{rows}</ListState>);
    expect(screen.getByTestId('list-loading')).toBeTruthy();
    await rerender(<ListState {...common} error={new Error('x')} empty>{rows}</ListState>);
    expect(screen.getByTestId('list-error')).toBeTruthy();
    await rerender(<ListState {...common} empty>{rows}</ListState>);
    expect(screen.getByText('Nothing yet')).toBeTruthy();
    await rerender(<ListState {...common} error={new Error('offline')} empty={false}>{rows}</ListState>);
    expect(screen.getByText('Row 1')).toBeTruthy();
    expect(screen.queryByTestId('list-error')).toBeNull();
  });

  test('a section has a heading a screen reader can jump to', async () => {
    await render(<Section title="Needs you"><NativeText>x</NativeText></Section>);
    expect(screen.getByRole('header', { name: 'Needs you' })).toBeTruthy();
  });
});

describe('charts', () => {
  test('a line puts higher values higher, and copes with one value, equal values and none', () => {
    const { points, line, area } = sparklinePath([1, 5, 3], 100, 40, 0);
    expect(points.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(points[1].y).toBeLessThan(points[2].y);
    expect(points[2].y).toBeLessThan(points[0].y);
    expect(line.startsWith('M0 40')).toBe(true);
    expect(area.endsWith('Z')).toBe(true);
    expect(sparklinePath([7], 100, 40, 0).points).toEqual([{ x: 0, y: 20 }, { x: 100, y: 20 }]);
    expect(sparklinePath([2, 2, 2], 100, 40, 0).points.every((p) => p.y === 20)).toBe(true);
    expect(sparklinePath([], 100, 40)).toEqual({ line: '', area: '', points: [] });
    expect(sparklinePath(['x', null, 4], 100, 40, 0).points).toHaveLength(3);
  });

  test('the tallest bar fills the height, a small one still shows, and a negative one is none', () => {
    const bars = barLayout([10, 0.01, -4, 5], { width: 100, height: 50, gap: 4 });
    expect(bars).toHaveLength(4);
    expect(bars[0]).toMatchObject({ y: 0, h: 50 });
    expect(bars[1].h).toBe(2);
    expect(bars[2].h).toBe(0);
    expect(bars[3].h).toBe(25);
    expect(bars[3].x + bars[3].w).toBeCloseTo(100, 0);
    expect(barLayout([0, 0], { width: 10, height: 10 }).every((b) => b.h === 0)).toBe(true);
  });

  test('a ring fills its share of the circle, never more than all of it', () => {
    expect(ringDash(50, 100, 10).share).toBe(0.5);
    expect(ringDash(150, 100, 10).share).toBe(1);
    expect(ringDash(-3, 100, 10).share).toBe(0);
    expect(ringDash(5, 0, 10).share).toBe(0);
  });

  test('each chart is one image to a screen reader, saying what the caller wrote, in the theme’s colours', async () => {
    const brand = fromBrandKit({ colors: { primary: '#0a7a55' } });
    await render(
      <ThemeProvider theme={brand}>
        <Sparkline testID="line" values={[3, 5, 4, 8]} label="Orders this week: 3, 5, 4, 8" />
        <BarChart testID="bars" data={[{ label: 'M', value: 3 }, { label: 'T', value: 5 }]} highlight={1} label="Monday 3, Tuesday 5" />
        <ProgressRing testID="ring" value={92} label="Account safety 92 of 100" />
      </ThemeProvider>,
    );
    for (const [id, label] of [['line', 'Orders this week: 3, 5, 4, 8'], ['bars', 'Monday 3, Tuesday 5'], ['ring', 'Account safety 92 of 100']]) {
      expect(screen.getByTestId(id).props.accessibilityRole).toBe('image');
      expect(screen.getByTestId(id).props.accessibilityLabel).toBe(label);
    }
    expect(screen.getByText('92')).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).toContain(`"payload":${processColor(brand.chart.line)}`); // svg holds colours as numbers
  });
});

describe('rules for every file in the kit', () => {
  const files = fs.readdirSync(__dirname).filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'));
  // Comments and the package names imported are left out: '@bhava/theme' is where the colours come from, not a name on screen.
  const source = (name) => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/from '@bhava\/[\w-]+'/g, "from ''");

  test('no file writes a colour out, uses an Android-only or iOS-only module, or names the platform', () => {
    expect(files).toEqual(expect.arrayContaining(['index.js', 'basics.js', 'controls.js', 'sheet.js', 'states.js', 'charts.js', 'theme-context.js']));
    for (const name of files) {
      const text = source(name);
      expect([name, text.match(/#[0-9a-fA-F]{3,8}\b/g)]).toEqual([name, null]);
      expect([name, /ToastAndroid|PermissionsAndroid|DrawerLayoutAndroid|ActionSheetIOS|DatePickerIOS|ProgressBarAndroid|react-native-webview/.test(text)]).toEqual([name, false]);
      expect([name, /bhava/i.test(text)]).toEqual([name, false]);
    }
  });

  test('every pressable gives a role and a label', () => {
    for (const name of files) {
      const text = source(name);
      // From each <Pressable to its style: every component here names its role and label before its style.
      const pressables = text.match(/<Pressable[\s\S]*?style=/g) ?? [];
      expect(pressables.length).toBeGreaterThanOrEqual(name === 'controls.js' ? 3 : 0);
      for (const tag of pressables) {
        if (/accessible=\{false\}/.test(tag)) continue; // the backdrop behind a sheet: the sheet's own close button is the way out
        expect([name, /accessibilityRole=/.test(tag), /accessibilityLabel=/.test(tag)]).toEqual([name, true, true]);
      }
    }
  });
});
