# Go-live sign-offs

`attestations.json` holds the sign-offs for the go-live items that no API can show: counsel's view on payment aggregator rules, the store accounts bought, the hosting region, the legal pages, the trademark search, the data-protection review, the sample businesses' sign-off. The items are in `src/contracts/golive.js` (`GOLIVE_ITEMS`, kind `attestation`); the format is `GoliveAttestations` there.

```json
{ "version": 1, "entries": [{ "id": "legal.pages", "signedOffBy": "Name", "role": "Counsel", "date": "2027-01-15", "reference": "where the evidence is kept" }] }
```

- One entry per item, signed off by a named person (two letters or more), with a role and a real calendar date (YYYY-MM-DD, not in the future). `reference` says where the evidence is kept (a folder, a ticket); the evidence itself, and anything confidential, never goes in this repository, which is public.
- An entry with no name, no role, no date, a date that is not a real day, an extra field, or an id that is not an attestation item counts for nothing, and the report says how many such entries there are. A file that is not JSON or not `{ "version": 1, "entries": [...] }` signs nothing off.
- An entry older than the item allows (`maxAgeDays`, a year for most, 180 days for the showcase, two years for the trademark) counts as missing. With two entries for one item, the newest counts.
- `npm run golive` reads this file (or the one `GOLIVE_ATTESTATIONS` names) and reports each item as ready or missing. The names and references in it are never printed.

## The checklist

`npm run golive` (text), `-- --json`, `-- --markdown` (for a ticket), `-- --blocking`, `-- --owner user|us`, `-- --offline` (no outside service is asked). It exits 1 while a blocking item is open. The Platform Console's Go-live screen shows the same list with the sign-up switch beside it.
