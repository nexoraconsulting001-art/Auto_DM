/** Pure: the brand kit form's rules, with no React Native, so the server's tests load it too. */
import { HEX_COLOUR } from '../products/limits.js';

/**
 * Pure: what the brand kit form sends (BrandKitUpdate), or { errors }. Only changed fields go; a colour left empty
 * goes back to the look's own; replies are one per line, at most 10 of 150 characters.
 */
export function brandKitBody(before, form) {
  const errors = {};
  const colors = {};
  for (const [slot, value] of Object.entries(form.colors)) {
    const v = String(value ?? '').trim();
    if (v && !HEX_COLOUR.test(v)) errors[`color.${slot}`] = 'brand-kit.colorBad';
    if (v !== (before.colors?.[slot] ?? '')) colors[slot] = v;
  }
  const replies = String(form.replies ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (replies.length > 10) errors.replies = 'brand-kit.repliesMany';
  else if (replies.some((r) => r.length > 150)) errors.replies = 'brand-kit.replyLong';
  for (const font of ['headingFont', 'bodyFont']) if (String(form[font] ?? '').trim().length > 80) errors[font] = 'brand-kit.fontLong';
  if (Object.keys(errors).length) return { errors };
  const body = {};
  for (const key of ['logoUrl', 'logoDarkUrl', 'faviconUrl']) if ((form[key] ?? '') !== (before[key] ?? '')) body[key] = form[key] ?? '';
  for (const key of ['headingFont', 'bodyFont']) if (String(form[key]).trim() !== (before[key] ?? '')) body[key] = String(form[key]).trim();
  if (Object.keys(colors).length) body.colors = colors;
  if (JSON.stringify(replies) !== JSON.stringify(before.publicReplyVariants ?? [])) body.publicReplyVariants = replies;
  return { body };
}
