/**
 * The creator page (PRD 8.14): one per business at /<name> on its own web address, with a shelf for each category. The order of
 * shelves and of reels inside them is the categories' own (8.13); nothing about order is set here.
 */
const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const HTTPS = /^https:\/\/[^\s\0]+$/i;

export const EMPTY_CREATOR = Object.freeze({ slug: '', enabled: false, displayName: '', bio: '', photoUrl: '', websiteUrl: '', showWhatsapp: true, moreShelfTitle: 'More' });

export function creatorToForm(page) {
  return {
    slug: page.slug ?? '',
    enabled: Boolean(page.enabled),
    displayName: page.displayName ?? '',
    bio: page.bio ?? '',
    photoUrl: page.photoUrl ?? '',
    websiteUrl: page.websiteUrl ?? '',
    showWhatsapp: Boolean(page.showWhatsapp),
    moreShelfTitle: page.moreShelfTitle || EMPTY_CREATOR.moreShelfTitle,
  };
}

/** What the owner typed as the page's name, as an address part: lower case, spaces to dashes. */
export const tidySlug = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, '-');

/** Why this can't be the page's name, or '' when its shape is fine. Whether it is free is the server's to say. */
export function slugProblem(text) {
  const slug = tidySlug(text);
  if (!slug) return 'Choose a name for your page’s address';
  if (!SLUG.test(slug)) return 'Use 2 to 40 lower-case letters, numbers and dashes';
  return '';
}

/** The form as the API takes it (CreatorPageUpdate), or `errors` by field. */
export function formToCreator(form) {
  const errors = {};
  const slug = tidySlug(form.slug);
  const slugError = slugProblem(slug);
  if (slugError) errors.slug = slugError;
  const displayName = form.displayName.trim();
  if (displayName.length > 80) errors.displayName = 'Use 80 characters or fewer';
  const bio = form.bio.trim();
  if (bio.length > 300) errors.bio = 'Use 300 characters or fewer';
  const websiteUrl = form.websiteUrl.trim();
  if (websiteUrl && !HTTPS.test(websiteUrl)) errors.websiteUrl = 'Use a web link starting with https://';
  else if (websiteUrl.length > 1000) errors.websiteUrl = 'That link is too long';
  const moreShelfTitle = form.moreShelfTitle.trim();
  if (!moreShelfTitle) errors.moreShelfTitle = 'Name the last shelf';
  else if (moreShelfTitle.length > 40) errors.moreShelfTitle = 'Use 40 characters or fewer';
  if (Object.keys(errors).length) return { errors };
  return { body: { slug, enabled: form.enabled, displayName, bio, photoUrl: form.photoUrl, websiteUrl, showWhatsapp: form.showWhatsapp, moreShelfTitle } };
}

/** The page's state in a few words, for the badge beside its title. */
export function creatorState(page) {
  if (!page.slug) return { tone: 'neutral', text: 'Not set up' };
  return page.enabled ? { tone: 'good', text: 'Live' } : { tone: 'neutral', text: 'Off' };
}

/** What the server said about a name, as the note under the field. `checked` is the name it was asked about. */
export function slugNote(check, typed) {
  if (!check || check.slug !== tidySlug(typed)) return { error: '', hint: '' };
  return check.available ? { error: '', hint: check.message || 'That name is free.' } : { error: check.message || 'That name is taken.', hint: '' };
}
