-- R2-P7-6: seller_payment_marks (741) was made with row security and its fence policy but no GRANT to the app role, so
-- billing's notePaymentMethod ("permission denied for table seller_payment_marks") could never write a mark and the
-- same-payment-method self-referral block (F-129) never ran. Billing writes a mark for the business it is working in;
-- the fence keeps each to its own business, and the 741 trigger compares across businesses with its own rights.
GRANT SELECT, INSERT ON seller_payment_marks TO bhava_app;
