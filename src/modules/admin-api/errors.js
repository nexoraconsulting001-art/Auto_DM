import { ApiError } from '../../contracts/api/index.js';
import { ValidationError } from '../../util.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** A 400 that names the field the person needs to fix. */
export const invalidField = (field, message) => new ApiError('validation_failed', message, { fields: { [field]: message } });

/** The repos check before they write, so two saves at once can both pass and one is refused by the database. That one gets a retry message, not a 500. */
export async function retryOnRace(write) {
  try {
    return await write();
  } catch (err) {
    if (err?.code === UNIQUE_VIOLATION || err?.code === FOREIGN_KEY_VIOLATION) throw new ApiError('conflict', 'That changed while you were saving. Please try again.');
    throw err;
  }
}

/** For changes whose input is already valid: when the repo refuses, it is because of the state of the record. */
export async function refusedByState(change) {
  try {
    return await change();
  } catch (err) {
    if (err instanceof ValidationError) throw new ApiError('conflict', err.message);
    throw err;
  }
}
