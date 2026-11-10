import { z } from 'zod';
import { RESERVED_PATHS } from '../buyer-pages.js';
import { MANAGERS } from './access.js';
import { MediaLinkOrEmpty, Timestamp, text } from './common.js';

/**
 * The creator page (PRD 8.14), answered by src/modules/creator: one per business at /<slug> on its own host, with a shelf per
 * category at /<slug>/<category slug>. Shelves follow the category order and each category's reel sequence (8.13); nothing
 * about order is kept here. The owner copies the link into their bio; Bhava never edits a bio.
 */
const CreatorSlug = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, 'Use 2 to 40 lower-case letters, numbers and dashes')
  .refine((slug) => !RESERVED_PATHS.includes(slug), 'That name is taken by a page of the store');

export const CreatorPage = z.object({
  slug: z.string(),
  enabled: z.boolean(),
  displayName: z.string(),
  bio: z.string(),
  photoUrl: z.string(),
  websiteUrl: z.string(),
  showWhatsapp: z.boolean(),
  moreShelfTitle: z.string(),
  /** The page's own address, to copy into the Instagram bio and list as a website. Empty until a slug is saved. */
  url: z.string(),
  /** The Free plan shows a small badge in the footer; paid plans show none (K-64). */
  badge: z.boolean(),
  updatedAt: Timestamp.nullable(),
});

export const CreatorPageUpdate = z.object({
  slug: CreatorSlug,
  enabled: z.boolean(),
  displayName: text(80),
  bio: text(300),
  photoUrl: MediaLinkOrEmpty,
  websiteUrl: z.union([z.literal(''), z.string().trim().max(1000).regex(/^https:\/\/[^\s\0]+$/i, 'Use a web link starting with https://').refine((s) => s.isWellFormed(), 'Contains a character that isn’t allowed')]),
  showWhatsapp: z.boolean(),
  moreShelfTitle: text(40).min(1),
}).partial();

export const SlugCheckQuery = z.object({ slug: text(60) });
export const SlugCheck = z.object({ slug: z.string(), available: z.boolean(), message: z.string() });

export const creatorRoutes = {
  'creator.get': { method: 'GET', path: '/creator-page', access: MANAGERS, response: CreatorPage },
  'creator.update': { method: 'PATCH', path: '/creator-page', access: MANAGERS, body: CreatorPageUpdate, response: CreatorPage },
  'creator.checkSlug': { method: 'GET', path: '/creator-page/slug', access: MANAGERS, query: SlugCheckQuery, response: SlugCheck },
};
