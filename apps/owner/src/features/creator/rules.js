/** Pure: the creator page form's rules, with no React Native, so the server's tests load it too. */
import { CREATOR_SLUG } from '../products/limits.js';

/** Pure: the changed fields of the creator page form, or the first problem by field (string keys). */
export function creatorBody(before, form) {
  const errors = {};
  const slug = String(form.slug ?? '').trim().toLowerCase();
  if (slug && !CREATOR_SLUG.test(slug)) errors.slug = 'creator.slugBad';
  const website = String(form.websiteUrl ?? '').trim();
  if (website && !/^https:\/\/[^\s\0]+$/i.test(website)) errors.websiteUrl = 'creator.websiteBad';
  if (!String(form.moreShelfTitle ?? '').trim()) errors.moreShelfTitle = 'creator.shelfRequired';
  if (Object.keys(errors).length) return { errors };
  const next = { slug, enabled: Boolean(form.enabled), displayName: form.displayName.trim(), bio: form.bio.trim(), photoUrl: form.photoUrl ?? '', websiteUrl: website, showWhatsapp: Boolean(form.showWhatsapp), moreShelfTitle: form.moreShelfTitle.trim() };
  const body = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== before[key] && !(key === 'slug' && !value)));
  return { body };
}
