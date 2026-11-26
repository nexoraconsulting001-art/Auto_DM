/** Is loyalty on, from what billing.features states (the plan, the business's own overrides, and what an app brings with it)? */
export const loyaltyFromFeatures = (data) => Boolean(data?.features?.loyalty?.on);
