# DPDP Act 2023 notes

Working notes for counsel, from PRD 9.18. This is not legal advice and nothing here is a legal opinion; counsel's review is a blocking go-live item (the go-live checklist: "data-protection notice, consent wording and grievance contact").

What the product does:

- A consent notice that names the business is shown at sign-in and at checkout, guest checkout included, in English and Hindi.
- Each consent record holds who, when, the notice version and the purposes: fulfilment, order updates, and marketing per channel. Marketing has its own consent. Withdrawing is as easy as giving, and it stops sends.
- Each business has privacy, terms, refund and shipping pages on its own domain, with a grievance contact.
- The shared shopper profile (verified phone or Google account, saved addresses, cash-on-delivery risk level) has its own consent screen that names Bhava as the data fiduciary, the data held, the purpose, how to withdraw and Bhava's grievance contact. Withdrawing deletes the shared profile; each business keeps only its own order and tax records.
- On deletion, personal data is erased and tax records are kept with personal data masked. For Meta platform data see data-handling.md.
- No tag loads and no server event is sent until the shopper accepts "Analytics and ads" in the business's consent banner.

Open points for counsel (not decided here):

- The split of roles between Bhava and each business for orders and customer records.
- Deletion timelines and breach notice under the DPDP Rules.
- Whether the processor must be named on a business's notices (the default is not named).
- The hosting region and data location.
- The retention set in retention.md.
