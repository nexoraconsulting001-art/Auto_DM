/**
 * The filter chips of the store's lists, as [value, words]. Each value is one the API's list query takes; a test keeps them so.
 * 'all' is the API's default, so choosing it leaves the filter out of the address.
 */
export const STOCK_SHOW = Object.freeze([['all', 'All'], ['low', 'Running low'], ['out', 'Sold out']]);
export const COUPON_SHOW = Object.freeze([['all', 'All'], ['active', 'Running'], ['ended', 'Ended']]);
export const DATA_REQUEST_SHOW = Object.freeze([['all', 'All'], ['open', 'Open'], ['completed', 'Done']]);
export const ALERT_SHOW = Object.freeze([['all', 'All'], ['failed', 'Failed'], ['skipped', 'Not sent'], ['sent', 'Sent']]);
/** The return statuses offered as filters: the ones a seller acts on or looks back at. */
export const RETURN_SHOW = Object.freeze(['requested', 'approved', 'pickup_scheduled', 'received', 'refunded', 'exchanged', 'rejected']);
