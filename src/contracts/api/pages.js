import { z } from 'zod';
import { CATALOG_LIMITS as L } from '../catalog.js';
import { BUYER_BLOCKS, PAGE_SURFACES } from '../buyer-pages.js';
import { MANAGERS, staffWith } from './access.js';
import { Count, Id, IdParams, ListQuery, MediaLinkOrEmpty, Paise, Timestamp, page, required, text } from './common.js';

/**
 * Landing pages (PRD 8.10), the WhatsApp order button (8.11), share previews (8.12) and the business's blocks (5.18),
 * answered by src/modules/pages. A landing page is a row of `reels`: one per automated reel, post or story, with its slug and
 * its products in the owner's order. Its address is the DM link, on the business's own host, with no redirect (K-32).
 * Tier 1 links one product to a page; tier 2 and above up to 20 (entitlements.limit('reel.products'), K-41).
 */
const access = staffWith('catalog');

export const LANDING_KINDS = Object.freeze(['reel', 'post', 'story']);
const Slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/, 'Use lower-case letters, numbers and dashes');

export const LandingPageProduct = z.object({ id: Id, name: z.string(), pricePaise: Paise, image: z.string(), active: z.boolean(), soldOut: z.boolean(), position: Count });
export const LandingPage = z.object({
  id: Id,
  kind: z.enum(LANDING_KINDS),
  channel: z.enum(['instagram', 'facebook']),
  mediaId: z.string(),
  slug: z.string(),
  headline: z.string(),
  description: z.string(),
  active: z.boolean(),
  permalink: z.string(),
  thumbnailUrl: z.string(),
  mediaType: z.string(),
  postedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  coverUrl: z.string(),
  leadForm: z.boolean().nullable(),
  /** The direct link for the DM, on the business's own host. */
  url: z.string(),
  categoryIds: z.array(Id),
  products: z.array(LandingPageProduct),
  productLimit: z.number().int().min(0),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const LandingPageSummary = LandingPage.omit({ products: true }).extend({ productCount: Count, visits: Count.nullable() });
export const PageListQuery = ListQuery.extend({ kind: z.enum(['all', ...LANDING_KINDS]).default('all'), status: z.enum(['all', 'active', 'inactive']).default('all'), search: text(80).optional() });

const PageFields = {
  slug: Slug.optional(),
  headline: text(200).optional(),
  description: text(300).optional(),
  active: z.boolean().optional(),
  /** The products in the order the page shows them (K-30). More than the plan allows is refused with an upgrade note (K-41). */
  productIds: z.array(Id).max(L.landingProducts, `A page can show at most ${L.landingProducts} products`).optional(),
  categoryIds: z.array(Id).max(100).optional(),
  /** Shown for a story after it expires (K-31); never the story's own media. */
  coverUrl: MediaLinkOrEmpty.optional(),
  leadForm: z.boolean().nullable().optional(),
};
export const PageCreate = z.object({
  channel: z.enum(['instagram', 'facebook']).default('instagram'),
  kind: z.enum(LANDING_KINDS),
  mediaId: z.string().regex(/^[\w-]{1,80}$/, 'Pick a post from your account'),
  ...PageFields,
  productIds: PageFields.productIds.unwrap().min(1, 'Pick at least 1 product'),
});
export const PageUpdate = z.object(PageFields);

/** A post, reel or story on the connected account, for choosing which gets a page. Stories show only while they are up. */
export const PageMediaChoice = z.object({
  channel: z.enum(['instagram', 'facebook']),
  mediaId: z.string(),
  kind: z.enum(LANDING_KINDS),
  caption: z.string(),
  permalink: z.string(),
  thumbnailUrl: z.string(),
  postedAt: Timestamp.nullable(),
  pageId: Id.nullable(),
});
export const PageMediaQuery = ListQuery.extend({ kind: z.enum(['all', ...LANDING_KINDS]).default('all') });

export const PageSettings = z.object({
  whatsappOrder: z.boolean(),
  /** False when the business has no WhatsApp number saved, or its plan lacks the button: then it never shows. */
  whatsappAvailable: z.boolean(),
  whatsappNumber: z.string(),
  whatsappTemplate: z.string(),
  landingNoindex: z.boolean(),
  moreReels: z.boolean(),
});
export const PageSettingsUpdate = z.object({
  whatsappOrder: z.boolean(),
  whatsappTemplate: required(500, 'Write the message').regex(/\{product\}/, 'Keep {product} in the message'),
  landingNoindex: z.boolean(),
  moreReels: z.boolean(),
}).partial();

const BlockName = z.enum(Object.keys(BUYER_BLOCKS));
export const PageBlock = z.object({ block: BlockName, visible: z.boolean(), settings: z.record(z.string(), z.unknown()) });
export const PageBlocks = z.object({ surface: z.enum(PAGE_SURFACES), custom: z.boolean(), blocks: z.array(PageBlock) });
export const PageBlocksQuery = z.object({ surface: z.enum(PAGE_SURFACES).default('landing') });
/** The business's whole layout for one surface, in order. Blocks not allowed on that surface are refused. */
export const PageBlocksSave = z.object({
  surface: z.enum(PAGE_SURFACES),
  blocks: z.array(z.object({ block: BlockName, visible: z.boolean().default(true), settings: z.record(text(40), z.unknown()).default({}) })).max(30),
}).superRefine((body, ctx) => {
  body.blocks.forEach((b, i) => {
    if (!BUYER_BLOCKS[b.block].surfaces.includes(body.surface)) ctx.addIssue({ code: 'custom', path: ['blocks', i, 'block'], message: 'That block can’t go on this page' });
  });
});

export const pageRoutes = {
  'pages.list': { method: 'GET', path: '/pages', access, query: PageListQuery, response: page(LandingPageSummary) },
  'pages.create': { method: 'POST', path: '/pages', access, body: PageCreate, status: 201, response: LandingPage },
  'pages.media': { method: 'GET', path: '/page-media', access, query: PageMediaQuery, response: page(PageMediaChoice) },
  'pages.get': { method: 'GET', path: '/pages/:id', access, params: IdParams, response: LandingPage },
  'pages.update': { method: 'PATCH', path: '/pages/:id', access, params: IdParams, body: PageUpdate, response: LandingPage },
  'pages.remove': { method: 'DELETE', path: '/pages/:id', access, params: IdParams, status: 204, response: null },
  'pageSettings.get': { method: 'GET', path: '/page-settings', access: MANAGERS, response: PageSettings },
  'pageSettings.update': { method: 'PATCH', path: '/page-settings', access: MANAGERS, body: PageSettingsUpdate, response: PageSettings },
  'pageBlocks.get': { method: 'GET', path: '/page-blocks', access: MANAGERS, query: PageBlocksQuery, response: PageBlocks },
  'pageBlocks.save': { method: 'PUT', path: '/page-blocks', access: MANAGERS, body: PageBlocksSave, response: PageBlocks },
};
