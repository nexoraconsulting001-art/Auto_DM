/** What each order status is called and how it looks. The keys are the contract's ORDER_STATUSES; a test keeps them in step. */
export const ORDER_STATUS = Object.freeze({
  awaiting_payment: { label: 'Awaiting payment', tone: 'warn' },
  payment_submitted: { label: 'Payment submitted', tone: 'neel' },
  paid: { label: 'Paid', tone: 'good' },
  shipped: { label: 'Shipped', tone: 'neel' },
  delivered: { label: 'Delivered', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
});

export const orderStatus = (status) => ORDER_STATUS[status] ?? { label: status, tone: 'neutral' };
