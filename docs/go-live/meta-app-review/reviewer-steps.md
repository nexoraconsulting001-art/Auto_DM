# Reviewer's test steps

Paste into the "Testing instructions" box of the submission. The review phone number and code go in the form's credentials fields by hand, never in this repository.

1. Open the review sign-in page: `https://<platform-host>/review` (path `/review`).
2. Sign in with the review phone number and review code from the credentials fields. The review login opens one sample business, "the demo business", and nothing else. It is a normal business with sample products, orders, conversations and automations.
3. The demo business never sends. Its messages are held and shown as "would send", so nothing reaches real people while you review.
4. Tap **Connect Instagram**. Instagram's consent screen lists four permissions: profile, messages, comments and insights. Allow them with the Instagram tester account given in the form (a person with a role on the app).
5. Back on Bhava you see "Instagram is connected.", the account's username and a table of the permissions granted.
6. Open **Inbox**, **Automations** and **Analytics** to see each permission in use (permissions.md says where each is used).
7. To see a real message, send a direct message or a comment from the second tester account given in the form. The reply arrives in that account.
8. Open the privacy policy from the link on the review page. It explains how to delete your data.
9. Tap **Disconnect Instagram**. The access token is deleted and sending stops at once.

Callbacks you may test with Meta's tools: the deauthorize callback and the data deletion callback, at the addresses in data-handling.md.

If anything does not work, the submission form's contact field names a person who answers the same day.
