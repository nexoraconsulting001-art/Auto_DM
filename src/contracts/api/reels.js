import { z } from 'zod';
import { staffWith } from './access.js';
import { Count, Id, ListQuery, Paise, Timestamp, page, required, text } from './common.js';

const access = staffWith('automations');

// A reel's id is its Instagram media id: digits, and too long for a number.
export const ReelParams = z.object({ id: z.string().regex(/^\d{1,40}$/) });

export const Reel = z.object({
  id: z.string(),
  slug: z.string(),
  headline: z.string(),
  keywords: z.array(z.string()),
  dmMessage: z.string(),
  buttonText: z.string(),
  publicReply: z.string(),
  active: z.boolean(),
  permalink: z.string(),
  thumbnailUrl: z.string(),
  videoUrl: z.string(),
  caption: z.string(),
  storeUrl: z.string(), // the direct link sent in the DM, on the business's own address
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const ReelSummary = Reel.extend({ productCount: Count, dmCount: Count, visitCount: Count, orderCount: Count });
export const ReelProduct = z.object({ id: Id, name: z.string(), pricePaise: Paise, images: z.array(z.string()), active: z.boolean(), position: Count });
export const ReelDetail = Reel.extend({ products: z.array(ReelProduct) });

/** Saving creates the reel's store the first time and replaces it after that. */
export const ReelSave = z.object({
  slug: text(60).optional(),
  headline: text(200).optional(),
  keywords: z.array(required(60)).min(1, 'Add at least one keyword people can comment').max(50),
  dmMessage: text(1000).optional(),
  buttonText: text(20).optional(),
  publicReply: text(1000).optional(),
  active: z.boolean().optional(),
  productIds: z.array(Id).min(1, 'Pick at least 1 product for this reel').max(20, 'A reel can show at most 20 products'),
  permalink: text(1000).optional(),
  thumbnailUrl: text(2000).optional(),
  videoUrl: text(2000).optional(),
  caption: text(500).optional(),
});

/** A post on the connected Instagram account, for choosing which one gets a store. */
export const InstagramPost = z.object({
  id: z.string(),
  caption: z.string(),
  mediaType: z.string(),
  permalink: z.string(),
  thumbnailUrl: z.string(),
  configured: z.boolean(),
});

export const reelRoutes = {
  'reels.list': { method: 'GET', path: '/reels', access, query: ListQuery, response: page(ReelSummary) },
  'reels.get': { method: 'GET', path: '/reels/:id', access, params: ReelParams, response: ReelDetail },
  'reels.save': { method: 'PUT', path: '/reels/:id', access, params: ReelParams, body: ReelSave, response: ReelDetail },
  'reels.remove': { method: 'DELETE', path: '/reels/:id', access, params: ReelParams, status: 204, response: null },
  'reels.instagramPosts': { method: 'GET', path: '/instagram/posts', access, query: ListQuery, response: page(InstagramPost) },
};
