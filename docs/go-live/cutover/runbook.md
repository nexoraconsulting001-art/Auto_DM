# Cutover runbook: the two single-shop apps move onto Bhava

For the two existing apps (Mehta Mart and Plant Store), one at a time, with the Phase 8 importer (`npm run migrate-business`, PRD 5.16, F-68 to F-73). Do the whole runbook for the first shop, check it, and only then start the second. Nothing here has been run on production; rehearse it first on a staging copy (the same build with the production options, R-05) with an export of fake data.

Who: an operator with the Platform Console and the platform's owner database connection. Time: plan a quiet hour for each shop, and tell the owner the day before.

What the import keeps and drops (so you can tell the owner): slugs, order numbers, order links and media are kept; ids are remapped; usernames and comment text are stripped; shopper password hashes, Instagram tokens and the old `.env` owner are not copied. Shoppers sign in with Google or a WhatsApp code on the same phone and see their old orders. Owners are invited again and sign in with Google or a WhatsApp code. The first new order after the import gets the next number after the highest old one.

Write down before you start: the old app's address and host, the new business's slug, the hosting provider's DNS panel, and who can reach the shop's owner by phone.

## 0. Before the day

1. Create the business in the Platform Console, with its slug, plan and the owner's invite. The importer needs the business to exist.
2. Take a backup of the Bhava platform and check it: see docs/runbooks/backup-restore.md. Do not go on without a restore that passed.
3. Ask the owner for an export of the old app: the old app's own export in the shape the importer reads (MigrationSource, src/contracts/migration.js). Keep it on the operator's machine only, never in the repository, and delete it when the cutover is signed off.
4. Plant Store has demo reels that point at Mehta Mart's Instagram account. Ask its owner now whether to **drop** them or **reassign** them (F-73); the import is blocked until you choose.
5. Lower the old host's DNS time to live to 5 minutes a day ahead, so the switch and a way back both take minutes.

## 1. Dry run

```
npm run migrate-business -- --source <export file> --tenant <slug>
```

A dry run is the default. It writes nothing at all and prints counts per table and every conflict by code, never a row. Read it with the owner:

- Counts match what the owner expects (products, orders, shoppers).
- No blocking conflict. Fix the cause and run the dry run again; do not go on while one is open.
- Repeat the dry run on the day of the cutover, with the fresh export.

## 2. Freeze

1. Tell the owner the shop is closing for orders for the hour. Put the old app in its maintenance mode, or stop its checkout, so no order arrives after the export.
2. Wait for payments in flight to settle, then take the final export from the old app.
3. Note the highest order number in the old app. The new app must start at that number plus one.

## 3. Import

```
npm run migrate-business -- --source <export file> --tenant <slug> --run --reason "<why>" [--reels drop|reassign] [--by <operator email>]
```

The real import runs in one transaction: any error, any blocking conflict, or counts that do not balance roll every row back, and nothing is half imported. It is safe to run again: rows already imported are skipped, and a finished run of the same export answers "already imported". `--reason` goes in the audit log with who and when.

If it fails, the report says which check failed. Fix the cause and run again. Never edit the database by hand.

## 4. Checks

Do each one and tick it. Any failure: stop and go to "Going back".

- [ ] Counts in the run report equal the dry run's counts.
- [ ] Products, collections and prices on the new storefront match the old one for five products picked at random.
- [ ] Open three old order links (the public order token links in old messages): each shows the right order.
- [ ] A migrated shopper signs in with a WhatsApp code on the same phone and sees their old orders (F-72).
- [ ] Place one test order, cash on delivery, on the new storefront. Its number is the old highest plus one (F-70). Cancel it after.
- [ ] Look at the migrated activity: no usernames and no comment text (F-71).
- [ ] The owner accepts the invite, signs in and sees their orders.
- [ ] The business connects its own Instagram account from the Connect screen. The release gates (docs/go-live/meta-app-review/release-gates.md) pass for it.
- [ ] No message went out to old shoppers about old orders.

## 5. Switch webhooks and DNS

Only after every check passes, and with the owner on the phone.

1. **Webhooks.** Instagram and Facebook events go to the platform's single address, not the old app's. Once the business has connected its own account on Bhava, remove the old app's subscription for that account so each event arrives once, and check the Platform Console health screen shows the webhooks as subscribed.
2. **Payments and shipping.** Point the shop's payment gateway and courier webhooks at Bhava's addresses, or finish the shop's onboarding steps for its own gateway keys. Do this from the shop's own provider consoles.
3. **DNS.** Point the shop's own domain at Bhava (the Platform Console shows the target and checks it). Wait for the console to show the certificate as issued.
4. **Old links.** The old host sends a permanent redirect for old paths to the same path on the new host (PRD 6), so links in old messages keep working.
5. Tell the owner the shop is open. Watch the first hour: new orders, the compliance log, the health screen.

## 6. Going back

Until step 5 is done, going back is only: leave the old app as it is, take it out of maintenance mode, tell the owner. The Bhava business can stay and be re-imported later.

After step 5, within the first days:

1. Put the DNS records back to the old values. Because the time to live is 5 minutes, shoppers are back on the old app in minutes.
2. Re-subscribe the old app's webhooks, and point the gateway and courier webhooks back.
3. Orders placed on Bhava since the switch exist only on Bhava. Export them from the console and enter them in the old app, or keep the shop on Bhava and fix forward. Decide with the owner; do not discard them.
4. Do not delete the Bhava business. Pause it in the Platform Console so nothing sends, and keep the data until the owner says otherwise.

## 7. After

- Delete the export file from the operator's machine.
- Restore the DNS time to live to its normal value after a week.
- Write the date, the run id and who did it in the Platform Console's notes for the business.

## Hosting checks to repeat on the real servers before the first cutover

These are PRD 11 R-05 to R-07. Run each on a staging copy first.

- R-05: the same build runs on a staging copy with the production options set (Redis, analytics database, object storage), and every test passes with no code change.
- R-06: with two web servers behind a load balancer, a seller's requests switch between them mid-session; the seller stays logged in, uploaded images show on both, and each scheduled job runs once.
- R-07: the database moved from the old VM to the new cloud from a backup; the platform is back with all its data and only configuration changed (docs/runbooks/backup-restore.md and `npm run drill`).
