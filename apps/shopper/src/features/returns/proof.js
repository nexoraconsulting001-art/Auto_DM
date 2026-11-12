/**
 * Photos and short videos from the phone's library, as the store's forms take them. Nothing is read into memory here: the files
 * go as multipart parts by their address on the phone. The picker is injected (expo-image-picker) so a test can stand in.
 */
export const PROOF_MAX_FILES = 4;
export const REVIEW_MAX_PHOTOS = 3;

const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime' };

/** One picked asset as a multipart part: { uri, name, type }. */
export function partOf(asset, index) {
  const ext = String(asset.fileName ?? asset.uri ?? '').split('.').pop().toLowerCase();
  const type = asset.mimeType || TYPES[ext] || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
  const name = asset.fileName || `file-${index + 1}.${Object.keys(TYPES).find((k) => TYPES[k] === type) ?? 'jpg'}`;
  return { uri: asset.uri, name, type };
}

export async function pickFiles({ picker, limit, video = false }) {
  const result = await picker.launchImageLibraryAsync({ mediaTypes: video ? ['images', 'videos'] : ['images'], allowsMultipleSelection: true, selectionLimit: limit, quality: 0.8 });
  if (!result || result.canceled) return [];
  return (result.assets ?? []).slice(0, limit).map(partOf);
}

/** A form with text fields and files under one name. */
export function formWith(fields, name, files) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  for (const file of files) form.append(name, file);
  return form;
}
