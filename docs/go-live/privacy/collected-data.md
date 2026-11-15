<!-- Written from apps/owner/store/collection.json and DATA_COLLECTED in src/contracts/apps.js by node tools/review-pack/index.mjs --write. Edit the source, not this file. -->

# What each surface collects, and why

## Bhava for Business (the seller app)

What Bhava for Business collects, and the files that collect it. The privacy manifest, the App Privacy answers and the Data safety answers are worked out from this file (answers.cjs). check.mjs reads the app: a field that takes a phone number, an email address, a name, an address or a payment detail, a photo or file picker, a device or push identifier, or an analytics or crash SDK, must be in the sources of an item here, and every source must still exist. Nothing is shared with a third party for its own use, nothing is used for tracking or advertising, and the app has no analytics or crash reporting SDK.

| Data | Why | Required | Tracking |
| --- | --- | --- | --- |
| Phone number | Signing in with a WhatsApp code, the account's own number, inviting team members, the business's payment and courier details and its grievance contact. | no | no |
| Email address | Signing in with Google or Apple, inviting team members, where reports are sent, and the business's payment, courier and store contact details. | no | no |
| Name | The account holder's name, team members' names, and the legal and contact names the payment account needs. | no | no |
| Physical address | The business's pickup address for couriers, the address printed on its invoices, and its grievance contact address. | no | no |
| Google or Apple account identifier | Signing in with Google or Sign in with Apple, or linking one to the account, ties that account to the seller. | no | no |
| Photos | Product photos and the business logo, which the seller chooses and uploads to their shop. | no | no |
| Files the seller imports | Catalog and data files (such as CSV) the seller chooses to import. | no | no |
| Messages to customers | Replies the seller writes in the inbox, sent to their customers on Instagram or Facebook Messenger. | no | no |
| Shop content the seller writes | Automation messages, product details and store pages the seller writes for their shop. | no | no |
| The business's payment details | The UPI id shown on payment QR codes and the business's own payment gateway key, entered after a fresh check and never shown back. | no | no |
| Device identifiers | A random id for each installation, the device's name and its push token, so Settings > Devices can list and sign out each phone and alerts reach it. | yes | no |
| Account activity | Sensitive changes (keys, team, account deletion) are recorded in the business's audit log, and each device's last use is shown in Settings > Devices. | yes | no |

## A seller's branded shopper app

Nothing is used for tracking or advertising. Payment details are the gateway's and are never held by the app.

| Data | Why | Required |
| --- | --- | --- |
| name | Address labels and order messages | no |
| phone | Signing in and delivery contact | yes |
| email | Receipts and sign-in with Google or Apple | no |
| address | Delivery | yes |
| purchase_history | Showing and tracking orders, returns and reviews | yes |
| device_id | Delivering notifications the person chose | yes |

## The web console and storefronts

The console holds what the business writes (products, orders, replies) and the conversations of its own customers. A storefront holds the shopper's details for fulfilment, and measures visits only after the shopper accepts "Analytics and ads" in the business's consent banner.

## The platform

Compliance log lines hold a hashed subject and a reason code, never a username or message text. Logs never hold personal data.
