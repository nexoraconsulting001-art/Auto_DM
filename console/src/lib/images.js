/** What the API's media upload takes (a test keeps these in step with the contract). */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Why this file can't be uploaded, or '' when it can. The server checks again. */
export function imageProblem(file) {
  if (!IMAGE_TYPES.includes(file.type)) return `${file.name} isn’t a JPG, PNG, WebP or GIF image.`;
  if (file.size > MAX_IMAGE_BYTES) return `${file.name} is larger than 5 MB.`;
  return '';
}

export const isWebLink = (text) => /^https?:\/\/\S+$/i.test(text);
