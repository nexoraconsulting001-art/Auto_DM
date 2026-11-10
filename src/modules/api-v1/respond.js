import { ApiError } from '../../contracts/api/index.js';
import { currentRequestId, reportError } from '../../platform/log.js';
import { ValidationError } from '../../util.js';

/** The ApiError for what other layers throw (repos, the body and upload parsers), or null for a real fault. */
function known(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof ValidationError) return new ApiError('validation_failed', err.message);
  if (err?.code === 'LIMIT_FILE_SIZE' || err?.status === 413) return new ApiError('payload_too_large');
  if (err?.name === 'MulterError') return new ApiError('validation_failed', 'That upload couldn’t be read.');
  if (err?.status >= 400 && err?.status < 500) return new ApiError('validation_failed', 'That request couldn’t be read.');
  return null;
}

/** Answers with any error in the one /api/v1 format (src/contracts/api/errors.js). */
export function sendApiError(err, req, res) {
  let failure = known(err);
  if (!failure) {
    reportError(err, { msg: 'http.error', method: req.method, path: req.path });
    failure = new ApiError('internal');
  }
  if (res.headersSent) return;
  const requestId = currentRequestId();
  res.status(failure.status).json({
    error: failure.message,
    code: failure.code,
    ...(failure.fields ? { fields: failure.fields } : {}),
    ...(requestId ? { requestId } : {}),
  });
}
