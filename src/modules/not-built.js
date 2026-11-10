import { ApiError } from '../contracts/api/index.js';

/**
 * Answers contract routes whose real handlers have not been written, so each route has exactly one module that owns it.
 * Replace an id with its handler as it is built. The answer is the 501 the router gives a route nobody answers.
 */
export const notBuilt = (...ids) =>
  Object.fromEntries(ids.map((id) => [id, () => { throw new ApiError('not_implemented'); }]));
