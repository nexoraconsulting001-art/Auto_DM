# Showcase script: Plant Store

A plant shop that sells off its Instagram reels. About 15 minutes, on a phone. Every person, number and photo here is invented, and nothing leaves the presenter's computer.

## What is simulated, and why

This is a rehearsal on made-up data, so it never needs a real Instagram account, a real bank or a server on the internet.

- Instagram and Facebook are simulated by the Meta simulator (`tools/sim/meta`). A comment is sent into the app signed the way Instagram signs it, and the DM the app sends back is caught by the simulator. Why: sending real DMs needs a connected account and Meta's approval, and a demo must not message anyone.
- Payment is in test mode, played by the Razorpay simulator. Why: no card, UPI app or bank account is touched, and no actual money moves.
- Shipping and courier updates are played by the Shiprocket simulator. Why: no plant is posted.
- WhatsApp messages (the sign-in code, order updates) land in the WhatsApp simulator, not on a phone.
- The branded shopper app is the real app code with this shop's brand, run in a preview on the presenter's machine. It is never sent to a store.
- Thirty days of past orders, comments and insights are generated data (`npm run showcase`), so the owner screens are not empty.

Everything else is the real product: the console, the landing page, the cart and checkout, the order flow and Reach Guard run exactly as they would for a live shop.

## Before you start

Run these on the presenter's computer. Nothing here connects to a deployed server.

```
npm run sim
npm run showcase
npm start
```

The owner opens the console at http://localhost:3000/admin on the phone (or the phone's browser tools pointed at the computer). The shop's own address is http://plant-store.localhost:3000/ . The owner signs in with the WhatsApp number of the sample owner and the code the WhatsApp simulator shows.

## The story

1. Show the reel first: Indoor starters, from the shop's sample Instagram account. Its caption says to comment PLANT for the list. This is a sample, not a live reel.
2. Play the shopper: send a comment that says PLANT on that reel through the Meta simulator. It reaches the app as a signed webhook, exactly as a real comment would.
3. Open the owner's inbox at `/admin/inbox`. The comment is there, and so is the DM the app sent back with the plant list and a See the plants button.
4. Tap the link in the DM. It opens the landing page at `/r/indoor-starters-picks` on the shop's own address. It is a direct link: no redirect, no shortener, and no Bhava name anywhere on the page.
5. Look at the page as the shopper does: the Plant Store name, the Mitti colours, the reel's plants in a grid. Open the reels tab at `/reels` to show the other reel, Balcony colour.
6. Pick two plants and tap `Add to bag`. The button on each is the shop's own colour.
7. Open the cart at `/cart` to see the lines and the total.
8. Go to checkout. Fill in an invented name and address, and choose to pay online. On a phone this is the same short form a shopper would see.
9. Apply the coupon GREEN15. It takes 15 percent off, up to Rs 150, on orders from Rs 399, and the total changes before paying.
10. Pay in test mode. The payment is played by the Razorpay simulator, which returns success and its signed message. No card or UPI is used. Say this out loud: the money is not real.
11. The order page opens with the thank-you and a tracking link. Keep this tab open, you come back to it in step 15.
12. Switch to the owner. Open home at `/admin`: today's orders and sales, and what needs doing first.
13. Open orders at `/admin/orders`. The new order is there as paid. Open it, mark it packed, and ship it. The courier is the Shiprocket simulator.
14. Open the shop's catalogue at `/admin/catalog` to show stock: a plant that sells out stops showing as available to shoppers.
15. Play the courier events from the simulator: picked up, out for delivery, delivered. Go back to the tracking page from step 10 and refresh. It shows each step in the shop's own words.
16. Open insights at `/admin/analytics`. Show the reel's reach, comments and orders over the thirty days of generated activity, and which reel sold best.
17. Open `/admin/reach-guard`. This is the owner's view of whether DMs are going out safely: the limits, the quiet hours and anything held back. Explain that the app will never send past these limits.
18. Open `/admin/my-app`. Show the shop's own app: its name, icon and colours, and where it is in the store steps. The store listing and review are simulated.
19. Show the shop's branded app in the preview on the computer: the same plants and cart, and the same Plant Store brand, with no Bhava name for the shopper.
20. Install the owner console on the phone. Open `/admin/settings/install` for the steps. On an iPhone it is Share, then Add to Home Screen.
21. Close by listing what was simulated: Instagram, WhatsApp, payment, courier and the store. The console, pages, checkout and Reach Guard were the real product.
