/**
 * The hosted driver: the store's own payment page, on the seller's address, in a system browser tab (Chrome Custom Tabs,
 * SFSafariViewController), never a web view inside the app. The tab closes when the page sends the shopper back to the app's
 * own link, or when the shopper closes it. Either way the result comes from the server, not from how the tab ended.
 */
const loadBrowser = () => require('expo-web-browser');

export function createHostedDriver({ confirm, pageUrl, returnUrl, browser } = {}) {
  if (typeof pageUrl !== 'function' || typeof returnUrl !== 'function') throw new Error('The hosted pay driver needs the payment page and the link back');
  return async function payHosted(order) {
    const tab = browser ?? loadBrowser();
    try {
      await tab.openAuthSessionAsync(pageUrl(order), returnUrl(order), { showInRecents: true });
    } catch {
      // The tab could not open or was torn down: the server still knows what was paid.
    }
    return confirm(order);
  };
}
