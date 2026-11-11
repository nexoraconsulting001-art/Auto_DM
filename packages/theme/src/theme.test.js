import fs from 'node:fs';
import path from 'node:path';
import { CSS_NAMES, color, contrast, font, fromBrandKit, sellerTheme, tap } from './index.js';

const css = fs.readFileSync(path.resolve(__dirname, '../../../console/src/design/tokens.css'), 'utf8');
const cssValue = (name) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css)?.[1].toLowerCase();

test('the seller tokens are the console tokens, colour for colour', () => {
  for (const [key, name] of Object.entries(CSS_NAMES)) expect([key, color[key]]).toEqual([key, cssValue(name)]);
  expect(color.ground).toBe('#f6f5f1');
  expect(color.ink).toBe('#16152b');
  expect(color.primary).toBe('#3b2fc9');
  expect(color.accent).toBe('#f5b83d');
  expect(color.goodText).toBe('#17694a');
});

test('the seller theme uses Unbounded and Figtree and a 44 point tap target', () => {
  expect(font.display).toMatch(/^Unbounded/);
  expect(font.body).toMatch(/^Figtree/);
  expect(tap.min).toBeGreaterThanOrEqual(44);
  expect(Object.isFrozen(sellerTheme)).toBe(true);
});

test('body text, good text and text on the primary colour reach 4.5:1', () => {
  expect(contrast(color.ink, color.ground)).toBeGreaterThan(4.5);
  expect(contrast(color.goodText, color.ground)).toBeGreaterThan(4.5);
  expect(contrast(color.onPrimary, color.primary)).toBeGreaterThan(4.5);
});

test('a brand kit becomes a theme with the same shape as the seller theme', () => {
  const theme = fromBrandKit(
    { colors: { primary: '#0A7', ground: '#fffaf0', ink: '#221100', card: '#ffffff', accent: '#ffcc00' }, headingFont: 'Lora', bodyFont: 'Inter' },
    { fonts: { Lora: 'Lora_700Bold' } },
  );
  expect(Object.keys(theme.color).sort()).toEqual(Object.keys(sellerTheme.color).sort());
  expect(Object.keys(theme).sort()).toEqual(Object.keys(sellerTheme).sort());
  expect(theme.color.primary).toBe('#00aa77');
  expect(theme.color.ink).toBe('#221100');
  expect(theme.font.display).toBe('Lora_700Bold');
  expect(theme.font.body).toBeUndefined(); // not embedded: the system font
  expect(contrast(theme.color.accentText, theme.color.ground)).toBeGreaterThanOrEqual(4.5);
});

test('a brand kit with nothing usable still gives a readable theme', () => {
  for (const kit of [undefined, null, {}, { colors: { primary: 'red; }', background: 12 } }, { colors: { ground: '#111111', ink: '#222222', muted: '#1a1a1a' } }]) {
    const theme = fromBrandKit(kit ?? undefined);
    expect(theme.color.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(theme.color.ink, theme.color.ground)).toBeGreaterThan(4.5);
    expect(contrast(theme.color.onPrimary, theme.color.primary)).toBeGreaterThan(4.5);
  }
});

test('a kit whose own text colour on primary is too faint is not used', () => {
  expect(fromBrandKit({ colors: { primary: '#ffee00', on_primary: '#ffffff' } }).color.onPrimary).toBe('#000000');
  expect(fromBrandKit({ colors: { primary: '#102040', on_primary: '#fff8e0' } }).color.onPrimary).toBe('#fff8e0');
});
