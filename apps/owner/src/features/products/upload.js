/**
 * Pure: the upload limits the owner app holds before anything is sent (PRD 10.4: the same limits as the web), and the
 * words for a refusal. Photos are 5 MB at most and JPG, PNG, WebP or GIF (IMAGE_UPLOAD in src/contracts/api/media.js);
 * a product CSV is 2 MB (8.6); a destination report 5 MB (DESTINATION_UPLOAD in insights.js). A file that breaks a limit is never sent. A file the server
 * still refuses shows the server's own sentence, which is written for the person.
 *
 * The numbers are the contract's (IMAGE_UPLOAD in src/contracts/api/media.js, CSV_UPLOAD in imports.js); the app may not
 * import src, so test/p5/app-insights-catalog holds these equal to them.
 *
 * An `asset` is what expo-image-picker or expo-document-picker hands back: { uri, fileName | name, mimeType, fileSize | size }.
 */
const MB = 1024 * 1024;

export const IMAGE_RULE = Object.freeze({
  kind: 'image',
  maxBytes: 5 * MB,
  mimeTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  extensions: Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'gif']),
  tooLarge: 'products.upload.imageTooLarge',
  wrongType: 'products.upload.imageType',
});

export const CSV_RULE = Object.freeze({
  kind: 'table',
  maxBytes: 2_000_000, // CATALOG_LIMITS.csvBytes
  mimeTypes: Object.freeze(['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/csv', 'application/octet-stream']),
  extensions: Object.freeze(['csv', 'txt']),
  tooLarge: 'products.upload.csvTooLarge',
  wrongType: 'products.upload.csvType',
});

export const REPORT_RULE = Object.freeze({
  kind: 'table',
  maxBytes: 5 * MB,
  mimeTypes: Object.freeze(['text/csv', 'application/vnd.ms-excel', 'text/plain']), // DESTINATION_UPLOAD
  extensions: Object.freeze(['csv', 'txt']),
  tooLarge: 'products.upload.reportTooLarge',
  wrongType: 'products.upload.csvType',
});

const nameOf = (asset) => String(asset?.fileName ?? asset?.name ?? asset?.uri?.split('/').pop() ?? '');
const extensionOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
/** The byte size the picker reported, or null when it did not say. */
export const sizeOf = (asset) => {
  const size = asset?.fileSize ?? asset?.size;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
};

/**
 * The type to send: for a photo, the picker's (image/jpg read as image/jpeg), else the one its name implies; for a
 * table, text/csv or text/plain by its name, else the picker's. Null when nothing says.
 */
export function typeOf(asset, rule = IMAGE_RULE) {
  const mime = String(asset?.mimeType ?? asset?.type ?? '').toLowerCase().split(';')[0].trim();
  const ext = extensionOf(nameOf(asset));
  if (rule.kind === 'image') {
    if (mime.startsWith('image/') && mime !== 'image/') return mime === 'image/jpg' ? 'image/jpeg' : mime;
    if (!rule.extensions.includes(ext)) return mime || null;
    return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  }
  if (ext === 'csv') return 'text/csv';
  if (ext === 'txt') return 'text/plain';
  if (mime === 'text/comma-separated-values') return 'text/csv';
  return mime || null;
}

/**
 * Why this file may not be sent, as a string key, or null when it may. A size the picker didn't give counts as a
 * problem ('products.upload.sizeUnknown'): the limit can't be held for a file whose size isn't known.
 */
export function fileProblem(asset, rule = IMAGE_RULE) {
  if (!asset?.uri) return 'products.upload.none';
  const type = typeOf(asset, rule);
  if (!type || !rule.mimeTypes.includes(type)) return rule.wrongType;
  const size = sizeOf(asset);
  if (size === null) return 'products.upload.sizeUnknown';
  if (size === 0) return 'products.upload.empty';
  if (size > rule.maxBytes) return rule.tooLarge;
  return null;
}

/** The file part to hand the API client: React Native's FormData takes { uri, name, type }. */
export function filePart(asset, rule = IMAGE_RULE) {
  const type = typeOf(asset, rule);
  const name = nameOf(asset) || `upload.${type?.split('/')[1] ?? 'bin'}`;
  return { uri: asset.uri, name, type };
}

/** A refusal the app makes itself, shaped like the API's so one place shows both. */
export class UploadRefused extends Error {
  constructor(key) {
    super(key);
    this.name = 'UploadRefused';
    this.code = 'upload_refused';
    this.key = key;
  }
}

/**
 * Checks a photo against the limits, then uploads it: { id, url } to put on a product, a logo or a page.
 * Throws UploadRefused (nothing was sent) or the API's error.
 */
export async function uploadImage(api, asset) {
  const problem = fileProblem(asset, IMAGE_RULE);
  if (problem) throw new UploadRefused(problem);
  return api.media.upload(filePart(asset, IMAGE_RULE));
}

/** The same for a file with another rule and another API call, such as `(file) => api.imports.csv(file)`. */
export async function uploadFile(asset, rule, send) {
  const problem = fileProblem(asset, rule);
  if (problem) throw new UploadRefused(problem);
  return send(filePart(asset, rule));
}

/** Codes whose sentence the server writes for the person: shown as they come. */
const SAYS_WHY = new Set(['validation_failed', 'payload_too_large', 'unsupported_media_type', 'conflict', 'rate_limited', 'upgrade_required']);

/**
 * The sentence to show for a failed change or upload. The app's own refusals use its words; the server's refusals
 * of the content (too large, wrong type, a field it won't take) use the server's sentence, the first field's message
 * when there is one; anything else (offline, no access, a fault) the app's general words, never internal detail.
 */
export function refusalText(t, error) {
  if (!error) return '';
  if (error instanceof UploadRefused || error?.code === 'upload_refused') return t(error.key);
  if (error?.code === 'cancelled') return '';
  if (error?.status === 0 || error?.code === 'network' || error?.code === 'offline') return t('error.network');
  if (SAYS_WHY.has(error?.code)) {
    const field = Object.values(error.fields ?? {}).find((m) => typeof m === 'string' && m);
    return field || error.message || t('error.saveFailed');
  }
  if (error?.status === 403) return t('error.forbidden');
  if (error?.status === 404) return t('error.notFound');
  return t('error.saveFailed');
}
