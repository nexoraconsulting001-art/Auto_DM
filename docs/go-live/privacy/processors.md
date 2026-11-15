# Processors

Who handles data for Bhava, and what they get. One line per outside service the code talks to (src/adapters). tools/review-pack fails when an adapter is added and not listed here. Names the sellers' notices do not have to carry are an open point for legal (dpdp.md).

| Service | What it handles | What it receives |
| --- | --- | --- |
| Meta (Instagram, Facebook) | Connecting accounts, receiving and sending messages and comments, insights | Message and comment content, account ids, tokens (to act as the business) |
| WhatsApp Business Platform (Meta) | Messages from a business's own number; login codes and alerts from Bhava's sender | Phone numbers and message content |
| Razorpay | Payments, refunds, split settlement | Order amounts, the payer's payment details (entered at Razorpay, never held by Bhava) |
| Shiprocket | Booking couriers and tracking | Delivery name, address, phone, parcel details |
| Shopify | Catalog and order sync for a business that connects its store | Products, orders, customers of that store |
| Google | Sign-in with Google | The signed-in person's Google account id and email |
| Apple | Sign-in with Apple; App Store distribution | The signed-in person's Apple account id and email |
| Firebase Cloud Messaging and Apple Push Notification service | Push notifications to the apps | A device token and the notification text |
| Email provider | Sign-in and alert emails | Email address and the email text |
| AI provider | Suggested replies for the business | The question and the business's own catalog and policy text; the contract forbids training on this traffic |
| Expo (cloud builds and updates) | Building and updating the mobile apps | No customer data; app code only |
| The hosting provider | Running the platform and storing its data | Everything, encrypted at rest; region is confirmed with counsel before go-live |

Every processor is used for the stated purpose only. No customer data is sold or shared for advertising.
