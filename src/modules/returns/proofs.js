import crypto from 'node:crypto';
import { ImageError } from '../../platform/images.js';
import { sniffImageType } from '../../platform/safe-fetch.js';
import { tenantId } from '../../tenancy.js';

/**
 * Return proof (PRD 9.17, S-80): at least one photo or short video of the item with every request, as the owner asked for
 * (photo, video or either). Files are judged by their bytes, never by the name or type the browser gave them: a "photo"
 * that isn't a picture, a page or a script is refused.
 *
 * Photos are decoded and written again (upright, no metadata such as where they were taken, at most 2000 px, WebP), so
 * nothing stored is the file as it arrived. Videos can't be re-encoded here, so only their container is checked: MP4 or
 * QuickTime (an ftyp box with a known brand) or WebM. Length limits are still to confirm (9.17): until then a size cap.
 *
 * Every file is kept in the business's private storage under t/<business>/returns/, never under /media, and is shown only
 * to the owner and staff with order access, by a link that is signed and lasts PROOF_LINK_MS.
 */
export const PROOF_LIMITS = Object.freeze({ files: 4, photoBytes: 10 * 1024 * 1024, videoBytes: 25 * 1024 * 1024, fieldBytes: 8 * 1024 });
export const PROOF_LINK_MS = 10 * 60_000;
export const PROOF_PATH = '/returns/proofs/:id';

/** What the refusal says for each setting, word for word (S-80). */
export const PROOF_MESSAGES = Object.freeze({
  either: 'Add a photo or video of the item',
  photo: 'Add a photo of the item',
  video: 'Add a short video of the item',
});
export const BAD_FILE = 'That file isn’t a photo or video we can use. Use a JPEG, PNG or WebP photo, or an MP4 or WebM video.';

const VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'qt  ', 'dash', '3gp4', '3gp5', '3gp6', '3g2a', 'mmp4', 'MSNV']);

/** 'photo' (with its type), 'video' (with its type), or null for anything else. */
export function sniffProof(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const image = sniffImageType(buffer);
  if (image) return { kind: 'photo', type: image };
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (VIDEO_BRANDS.has(brand)) return { kind: 'video', type: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4' };
    return null;
  }
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return { kind: 'video', type: 'video/webm' };
  return null;
}

/**
 * Checks and prepares the uploaded files. Returns [{ kind, contentType, buffer }] ready to store, or throws a ProofError
 * with the sentence for the shopper.
 */
export class ProofError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ProofError';
    this.status = status;
  }
}

export async function prepareProofs(files, required, images) {
  const list = Array.isArray(files) ? files : [];
  const ready = [];
  for (const file of list) {
    const found = sniffProof(file.buffer);
    const declared = String(file.mimetype ?? '').toLowerCase();
    // A file the browser calls a page or a script is refused whatever its bytes look like.
    if (!found || !(declared.startsWith('image/') || declared.startsWith('video/') || declared === 'application/octet-stream')) throw new ProofError(BAD_FILE);
    if (found.kind === 'photo') {
      if (file.buffer.length > PROOF_LIMITS.photoBytes) throw new ProofError('That photo is too large. Use one under 10 MB.', 413);
      let clean;
      try {
        clean = await images.ingest(file.buffer);
      } catch (err) {
        if (err instanceof ImageError || err?.code === 'bad_image') throw new ProofError(BAD_FILE);
        throw err;
      }
      ready.push({ kind: 'photo', contentType: clean.contentType, buffer: clean.buffer });
    } else {
      if (file.buffer.length > PROOF_LIMITS.videoBytes) throw new ProofError('That video is too large. Use a short one under 25 MB.', 413);
      ready.push({ kind: 'video', contentType: found.type, buffer: file.buffer });
    }
  }
  const has = (kind) => ready.some((p) => p.kind === kind);
  const enough = required === 'photo' ? has('photo') : required === 'video' ? has('video') : ready.length > 0;
  if (!enough) throw new ProofError(PROOF_MESSAGES[required] ?? PROOF_MESSAGES.either, 422);
  return ready;
}

const EXT = Object.freeze({ 'image/webp': 'webp', 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' });

/** A fresh private key in this business's storage. Never under media/. */
export const proofKey = (contentType) => `t/${tenantId()}/returns/${crypto.randomUUID()}.${EXT[contentType] ?? 'bin'}`;

const sign = (secret, tenant, id, exp) => crypto.createHmac('sha256', String(secret)).update(`return-proof:${tenant}:${id}:${exp}`).digest('base64url');

/** A short-lived link to one proof, for the owner and staff with order access. */
export function proofUrl(secret, id, now = Date.now()) {
  const exp = Math.floor((now + PROOF_LINK_MS) / 1000);
  return `/returns/proofs/${Number(id)}?exp=${exp}&sig=${sign(secret, tenantId(), Number(id), exp)}`;
}

/** True when the link's signature is this business's and it hasn't run out. */
export function proofLinkValid(secret, id, exp, sig, now = Date.now()) {
  const e = Number(exp);
  if (!Number.isSafeInteger(e) || e * 1000 < now || typeof sig !== 'string' || sig.length > 100) return false;
  const want = Buffer.from(sign(secret, tenantId(), Number(id), e));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
