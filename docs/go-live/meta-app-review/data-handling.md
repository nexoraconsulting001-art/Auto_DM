# Data handling answers

For the App Review "Data Handling" questions. Plain answers, from the code. Retention details are in ../privacy/retention.md.

**Who are the controllers and processors?** The business (seller) decides what it does with its customers' messages; Bhava processes them for the seller to run the automations, inbox and analytics. Processors are listed in ../privacy/processors.md.

**What data do we receive from Meta?** Instagram: the connected account's id, username and profile picture; messages and comments sent to the account; the account's and posts' insight figures. Facebook: the chosen Page's id and name, messages and comments on the Page. WhatsApp: the connected account, number and templates, and messages on that number.

**Do we sell or share it?** No. Nothing is sold, used for advertising, or used to build profiles. Each business's data is visible only to that business.

**How is it stored?** Every row belongs to one business and the database refuses to show it to another. Access tokens are encrypted, one data key per record, and are never written to logs or shown after saving. Logs hold ids, never usernames, message text or phone numbers.

**How long is it kept?** See ../privacy/retention.md. The compliance log is purged after 13 months; a business's data is deleted when it asks, within the time stated on the privacy page.

**Deauthorize callback.** When a person removes the app in Instagram, Meta calls `https://<platform-host>/meta/deauthorize` (path `/meta/deauthorize`). The token is deleted and sending stops at once.

**Data deletion callback.** `https://<platform-host>/meta/deletion` (path `/meta/deletion`). It answers with a confirmation code and a status address, `https://<platform-host>/meta/deletion/<confirmation code>` (path `/meta/deletion/:code`), which shows progress.

**Privacy policy.** `https://<platform-host>/privacy` (path `/privacy`). It includes how to delete your data.

**Tech Provider.** Bhava applies as a Tech Provider; Business Verification must be complete before submission (see submission-checklist.md).
