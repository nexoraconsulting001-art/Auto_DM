# Retention

How long each kind of data is kept. The periods are PRD 4.14 and 4.16; legal confirms the set once (see dpdp.md). A period the code does not enforce yet is not claimed here.

| Data | Kept for |
| --- | --- |
| Raw webhook events from Meta | 7 days |
| Comment and message text, and usernames shown in the inbox | 30 days |
| The "Why no DM?" view | 90 days |
| Per-person send limits (cap keys) | The life of the automation plus 90 days |
| The opt-out list | While the business is active |
| Compliance log (hashed subjects, reason codes, never text) | 13 months |
| Account Health history | 90 days |
| Orders and tax records | As the law requires; personal details are masked on deletion and the record stays |
| Access tokens | Until the business disconnects or Meta removes the app; deleted at once then |
| Raw event log exports | A limited time, and each export is itself logged |

Deletion: a business can ask for its data to be deleted, a person can remove the app from Instagram or Facebook (the deauthorize callback deletes the token and stops sending), and Meta's data deletion callback answers with a confirmation code and a progress page. On deletion personal data is erased; tax records stay with personal details masked.
