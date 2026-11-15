# Go-live sign-offs

`attestations.json` holds the sign-offs for the go-live items that no API can show: counsel's view on payment aggregator rules, the store accounts bought, the trademark search, the legal pages reviewed, the sample businesses' sign-off. The items are in `src/contracts/golive.js` (`GOLIVE_ITEMS`, kind `attestation`); the format is `GoliveAttestations` there.

```json
{ "version": 1, "entries": [{ "id": "legal.pages", "signedOffBy": "Name", "role": "Counsel", "date": "2027-01-15", "reference": "where the evidence is kept" }] }
```

- One entry per item, signed off by a named person on a date. `reference` says where the evidence is kept (a folder, a ticket); the evidence itself, and anything confidential, never goes in this repository, which is public.
- An entry older than the item allows counts as missing.
- `npm run golive` reads this file (or the one `GOLIVE_ATTESTATIONS` names) and reports each item as ready or missing.
