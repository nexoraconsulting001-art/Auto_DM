-- Final review (commerce-3, PRD 9.14): a cancelled order that comes back (order.reinstated) takes its coupon use back. If the
-- code was used up meanwhile the order keeps its discount and its use still counts per customer, but used_count cannot pass
-- max_uses (the coupons check), so that use is not in used_count. `counted` records whether this redemption is in
-- used_count, so cancelling the order again gives back only what was taken.
ALTER TABLE coupon_redemptions ADD COLUMN counted boolean NOT NULL DEFAULT true;
