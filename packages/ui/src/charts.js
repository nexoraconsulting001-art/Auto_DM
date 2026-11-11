/**
 * Small charts for a phone, drawn with react-native-svg so they look the same on Android and iOS: a line over time
 * (Sparkline), a few bars (BarChart) and a score out of a hundred (ProgressRing). Each is one image to a screen
 * reader, and `label` is what it says, so the caller writes the numbers out ("Orders this week: 3, 5, 4, 8").
 *
 * The geometry is worked out by the pure functions below, which tests check without drawing anything.
 */
import React from 'react';
import { Text as NativeText, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from './theme-context.js';

const finite = (values) => (Array.isArray(values) ? values : []).map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
const round = (n) => Math.round(n * 100) / 100;

/**
 * The line through `values` across `width` by `height`, inside `pad`: { line, area, points }. Higher values sit
 * higher. One value is a flat line, all-equal values sit in the middle, and nothing at all draws nothing.
 */
export function sparklinePath(values, width, height, pad = 2) {
  const list = finite(values);
  if (list.length === 0 || !(width > 0) || !(height > 0)) return { line: '', area: '', points: [] };
  const series = list.length === 1 ? [list[0], list[0]] : list;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  const points = series.map((value, i) => ({
    x: round(pad + (innerW * i) / (series.length - 1)),
    y: round(span === 0 ? pad + innerH / 2 : pad + innerH - ((value - min) / span) * innerH),
  }));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  const bottom = round(height - pad);
  const area = `${line} L${points.at(-1).x} ${bottom} L${points[0].x} ${bottom} Z`;
  return { line, area, points };
}

/**
 * Bars for `values` side by side across `width`, standing on the bottom of `height`: [{ x, y, w, h }]. The tallest
 * fills the height; a value above nothing still shows a sliver, so a small day is not mistaken for none; a negative
 * value is drawn as none.
 */
export function barLayout(values, { width, height, gap = 6 }) {
  const list = finite(values).map((v) => Math.max(0, v));
  if (!list.length || !(width > 0) || !(height > 0)) return [];
  const max = Math.max(...list);
  const w = Math.max(1, (width - gap * (list.length - 1)) / list.length);
  return list.map((value, i) => {
    const h = max === 0 || value === 0 ? 0 : Math.max(2, (value / max) * height);
    return { x: round(i * (w + gap)), y: round(height - h), w: round(w), h: round(h) };
  });
}

/** How much of a ring of `radius` a score fills: the circle's length and the dash pattern, clamped to 0..max. */
export function ringDash(value, max, radius) {
  const circumference = 2 * Math.PI * radius;
  const share = max > 0 ? Math.min(1, Math.max(0, (Number(value) || 0) / max)) : 0;
  return { circumference: round(circumference), share, dasharray: `${round(circumference * share)} ${round(circumference)}` };
}

/** A line over time, with the area under it and the latest point marked. */
export function Sparkline({ values, width = 300, height = 64, label, area = true, markLast = true, testID }) {
  const theme = useTheme();
  const { line, area: fill, points } = sparklinePath(values, width, height, 6);
  const last = points.at(-1);
  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {area && fill ? <Path d={fill} fill={theme.chart.fill} /> : null}
        {line ? <Path d={line} fill="none" stroke={theme.chart.line} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" /> : null}
        {markLast && last ? <Circle cx={last.x} cy={last.y} r={5} fill={theme.chart.highlight} /> : null}
      </Svg>
    </View>
  );
}

/**
 * A few bars with their labels under them, such as orders on each day of the week. `data` is [{ label, value }];
 * `highlight` is the index drawn in the accent colour (today). The bars stretch to the width they are given.
 */
export function BarChart({ data, height = 120, label, highlight = -1, testID }) {
  const theme = useTheme();
  const items = Array.isArray(data) ? data.slice(0, 31) : [];
  // Drawn on a grid of 10-wide bars with 3 between, then stretched to the real width.
  const gap = 3;
  const viewWidth = Math.max(1, items.length * 10 + (items.length - 1) * gap);
  const bars = barLayout(items.map((d) => d.value), { width: viewWidth, height, gap });
  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={label} style={{ gap: theme.space[1] }}>
      <Svg width="100%" height={height} viewBox={`0 0 ${viewWidth} ${height}`} preserveAspectRatio="none">
        {bars.map((bar, i) => (
          <Rect key={i} x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx={2} fill={i === highlight ? theme.chart.highlight : theme.chart.bar} />
        ))}
      </Svg>
      <View style={{ flexDirection: 'row' }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {items.map((item, i) => (
          <NativeText key={i} numberOfLines={1} style={{ flex: 1, textAlign: 'center', fontFamily: theme.font.bodyMedium, fontSize: theme.text.caption, color: theme.chart.label }}>
            {String(item.label ?? '')}
          </NativeText>
        ))}
      </View>
    </View>
  );
}

/** A score in a ring, such as account safety 92 of 100. `children` sits in the middle (the number, by default). */
export function ProgressRing({ value, max = 100, size = 72, stroke = 8, label, children, testID }) {
  const theme = useTheme();
  const radius = (size - stroke) / 2;
  const { dasharray } = ringDash(value, max, radius);
  const centre = size / 2;
  return (
    <View testID={testID} accessible accessibilityRole="image" accessibilityLabel={label} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', top: 0, left: 0 }}>
        <Circle cx={centre} cy={centre} r={radius} fill="none" stroke={theme.chart.track} strokeWidth={stroke} />
        <Circle cx={centre} cy={centre} r={radius} fill="none" stroke={theme.chart.line} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={dasharray} transform={`rotate(-90 ${centre} ${centre})`} />
      </Svg>
      {children ?? <NativeText style={{ fontFamily: theme.font.display, fontSize: theme.text.title, color: theme.color.ink }}>{String(Math.round(Number(value) || 0))}</NativeText>}
    </View>
  );
}
