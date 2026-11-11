/**
 * The pages each store area links between, as [to, text]. Paths are relative to /admin. Every page of an area shows the same
 * row, so a seller moves sideways without the menu.
 */
export const ORDER_AREA = Object.freeze([['/orders', 'Orders'], ['/returns', 'Returns'], ['/invoices', 'Invoices'], ['/orders/files', 'Files']]);
export const CUSTOMER_AREA = Object.freeze([['/customers/shoppers', 'Shoppers'], ['/customers', 'Accounts'], ['/customers/data-requests', 'Data requests']]);
export const LOYALTY_TAB = Object.freeze(['/loyalty', 'Loyalty']);
export const STOCK_AREA = Object.freeze([['/inventory', 'Stock'], ['/inventory/movements', 'Stock changes']]);
export const REVIEW_AREA = Object.freeze([['/reviews', 'Reviews'], ['/reviews/saves', 'Saved by shoppers']]);
export const PAYMENT_AREA = Object.freeze([['/payments', 'How you’re paid'], ['/payments/statement', 'Statement']]);
