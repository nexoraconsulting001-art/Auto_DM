/** The words and destinations for the setup steps. The server decides which are done; the console says what they mean. */
export const CHECKLIST_STEPS = Object.freeze({
  instagram: { title: 'Connect Instagram', text: 'Connect your Instagram account so comments can be answered with a DM.', action: 'Check connection', to: '/settings' },
  store_details: { title: 'Add your store details', text: 'Store name, logo, WhatsApp number and delivery fee.', action: 'Open settings', to: '/settings' },
  products: { title: 'Add products', text: 'Photos, price and MRP. Group them into categories for the shop.', action: 'Add a product', to: '/products/new' },
  reel: { title: 'Set up your first reel store', text: 'Pick a reel, choose its products and the keyword people comment.', action: 'Choose a reel', to: '/reels' },
  comment: { title: 'Receive a comment', text: 'Comment your keyword on the reel from another account. The DM shows up in DM activity.', action: 'See DM activity', to: '/activity' },
  order: { title: 'Get your first order', text: 'Share your store link. Orders land in Orders for you to confirm.', action: 'Open your store', href: '/' },
});

/** The checklist as the screen shows it. Finished or dismissed, it isn't shown at all. */
export function checklistView(checklist) {
  const steps = checklist.steps.filter((step) => CHECKLIST_STEPS[step.key]);
  const done = steps.filter((step) => step.done).length;
  const nextKey = steps.find((step) => !step.done)?.key;
  return {
    visible: !checklist.dismissed && done < steps.length,
    done,
    total: steps.length,
    steps: steps.map((step) => ({ ...CHECKLIST_STEPS[step.key], key: step.key, done: step.done, next: step.key === nextKey })),
  };
}
