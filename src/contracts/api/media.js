import { z } from 'zod';
import { staffWith } from './access.js';

export const IMAGE_UPLOAD = Object.freeze({
  field: 'file',
  maxBytes: 5 * 1024 * 1024,
  mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
});

/** `url` is what product images and brand kit logos take. */
export const MediaUploaded = z.object({ id: z.uuid(), url: z.string() });

export const mediaRoutes = {
  'media.upload': { method: 'POST', path: '/media', access: staffWith('catalog'), upload: IMAGE_UPLOAD, status: 201, response: MediaUploaded },
};
