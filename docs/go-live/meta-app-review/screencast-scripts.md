<!-- Written from docs/go-live/meta-app-review/pack.json by node tools/review-pack/index.mjs --write. Edit the source, not this file. -->

# Screencast scripts

One recording per script. Record on a phone, in the real app, with the real tester accounts. Say nothing that is not in the script; show each tap, and hold on each "must be visible" line for two seconds. The rehearsal named under a script is a Playwright flow that walks it against the simulators and saves a video: run it first, watch the video, then record the real one.

Rehearse: `npx playwright test e2e/p9/screencasts --project=phone` (videos land in test-results; nothing leaves this machine).

## sc-01-instagram-connect: Connect an Instagram account

Permissions shown: `instagram_business_basic`

Start: The review sign-in page on the platform host, on a phone-sized screen.

Rehearsal: `e2e/p9/screencasts/reviewer.spec.js`

| # | Tap | Must be visible |
| --- | --- | --- |
| 1 | Open the review sign-in page and enter the review phone number and the review code from the submission form. | The Bhava review page, signed in, with 'No account is connected yet.' |
| 2 | Tap Connect Instagram. | Instagram's own consent screen, listing the four permissions: profile, messages, comments and insights. |
| 3 | Allow all four. | Back on Bhava: 'Instagram is connected.', the account's @username, and a table of every permission that was granted. |
| 4 | Tap the privacy policy link. | The privacy policy, with the heading about how to delete your data. |
| 5 | Go back and tap Disconnect Instagram. | 'Instagram is disconnected. The access token has been deleted.' and 'No account is connected yet.' |

## sc-02-messages: Receive and reply to a direct message

Permissions shown: `instagram_business_manage_messages`

Start: Signed in to the console as the demo business's owner, with Instagram connected.

Rehearsal: none (needs a real tester account; the script is walked on the real app)

| # | Tap | Must be visible |
| --- | --- | --- |
| 1 | From a second Instagram account that holds a tester role on the app, send a direct message to the connected account. | The message arrives on the phone being recorded. |
| 2 | Open Inbox in the console. | The conversation with that message, newest first. |
| 3 | Type a reply and tap Send. | The reply shows as sent, and arrives in the tester account's Instagram inbox. |
| 4 | Open the compliance log for that conversation. | A line saying the message was sent, and the rule that allowed it. No message text appears in the log. |

## sc-03-comments: Comment on a post and get a private reply

Permissions shown: `instagram_business_manage_comments`

Start: Signed in as the owner, with one automation on a post: keyword 'LINK', a public reply and a private reply.

Rehearsal: none (needs a real tester account; the script is walked on the real app)

| # | Tap | Must be visible |
| --- | --- | --- |
| 1 | Open Automations and open the automation. | The post, the keyword, the public reply and the private reply, with the switch on. |
| 2 | From the tester account, comment the keyword on that post. | The comment appears under the post. |
| 3 | Wait a few seconds, then open the post on the tester account. | The seller's public reply under the comment, and a direct message with the link in the tester's inbox. |
| 4 | Open Inbox in the console. | The comment thread, with both replies marked as sent by the automation. |

## sc-04-insights: See account and post insights

Permissions shown: `instagram_business_manage_insights`

Start: Signed in as the owner, with Instagram connected and insights allowed.

Rehearsal: `e2e/p9/screencasts/insights.spec.js`

| # | Tap | Must be visible |
| --- | --- | --- |
| 1 | Open Analytics. | Account figures by day, each labelled with its source and when it was last updated; the last two days flagged as still changing. |
| 2 | Tap a metric such as Comments. | The metric's days; a day with no number says No data. |
| 3 | Tap Refresh now. | A line saying when the figures were updated. |

## sc-05-facebook-page: Connect a Facebook Page and answer a Page message

Permissions shown: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `pages_manage_engagement`

Start: Signed in as the owner, on the Connect screen, Facebook section.

Rehearsal: none (needs a real tester account; the script is walked on the real app)

| # | Tap | Must be visible |
| --- | --- | --- |
| 1 | Tap Connect Facebook Page. | Facebook's own consent screen, listing the Page permissions. |
| 2 | Choose the Page and allow. | Back on Bhava: the Page's name, the connected badge and the webhook status. |
| 3 | From a tester account, send the Page a message and comment on a Page post. | Both arrive on the phone being recorded. |
| 4 | Open Inbox and reply to the message. | The reply shows as sent and arrives in Messenger. |
| 5 | Open the Page automation and show the public reply under the comment. | The seller's reply under the tester's comment on the Page post. |

## sc-06-whatsapp: Connect WhatsApp and send a template message

Permissions shown: `whatsapp_business_management`, `whatsapp_business_messaging`

Start: Signed in as the owner of a business that has the WhatsApp add-on, on the WhatsApp screen.

Rehearsal: none (needs a real tester account; the script is walked on the real app)

| # | Tap | Must be visible |
| --- | --- | --- |
| 1 | Tap Connect WhatsApp. | Meta's embedded signup, asking which account and number to connect. |
| 2 | Finish the signup. | Back on Bhava: the number, its quality status and the template list. |
| 3 | Open a template and tap Send test to the owner's own number. | The message arrives on the owner's WhatsApp. |
| 4 | From the owner's number, reply to it. | The reply shows in the WhatsApp conversation list. |
