<!-- Written from docs/go-live/meta-app-review/pack.json and the code by node tools/review-pack/index.mjs --write. Edit the source, not this file. -->

# Permissions the code asks for

Every permission below is one the code asks for today (the Instagram and Facebook scope lists in src/adapters/meta/login.js, the WhatsApp ones in src/contracts/golive.js). `node tools/review-pack/index.mjs` fails if one is missing here or one here is no longer asked for. Request Advanced Access for each, and nothing else.

## Instagram Login

### instagram_business_basic

- **Used for:** Reads the connected professional account's id, username and profile picture, so a business can see which account is connected and Bhava can match webhook events to the right business.
- **Where in the product:** Connect screen (account name, connected badge and the list of what was allowed); the account name in the console header.
- **Screencast:** sc-01-instagram-connect (screencast-scripts.md)

**Justification text for the submission box:**

> Our app lets a business connect its own Instagram professional account and automate replies to its own customers. We need instagram_business_basic to identify the account the business connected, show its username on the Connect screen so the owner can confirm it is the right account, and route incoming events to that business only. Without it the business cannot tell which account is linked and no other permission can work. We read only the connected account, never other people's profiles.

### instagram_business_manage_messages

- **Used for:** Receives direct messages sent to the business and sends the business's own replies, inside Meta's 24-hour window and only through Bhava's compliance checks.
- **Where in the product:** Inbox (read and reply); Automations (a keyword or comment starts a reply); the compliance log that says why a message was or was not sent.
- **Screencast:** sc-02-messages (screencast-scripts.md)

**Justification text for the submission box:**

> Our app helps small sellers answer customers who message their Instagram account. We need instagram_business_manage_messages to receive a customer's message through the webhook, show it in the seller's inbox, and send the seller's reply or the seller's own automation reply to that same customer. We send only to people who messaged the business first, inside the 24-hour window, with a visible opt-out, with per-person and per-comment limits, and never promotional text from Bhava.

### instagram_business_manage_comments

- **Used for:** Reads comments on the business's own posts and reels and replies to them, including the comment-to-DM flow where a keyword in a comment starts a private reply.
- **Where in the product:** Automations (comment trigger and public reply); Inbox (comment threads).
- **Screencast:** sc-03-comments (screencast-scripts.md)

**Justification text for the submission box:**

> Sellers ask customers to comment a word on a post to get the product link. We need instagram_business_manage_comments to receive those comments for the seller's own media, match the seller's keyword, post the seller's public reply, and start the private reply. Replies are limited per comment, per post and per hour, and comments are only read for the account that connected.

### instagram_business_manage_insights

- **Used for:** Reads reach, views, interactions and audience figures for the connected account and its media, so the business sees how posts and automations perform.
- **Where in the product:** Analytics (account and post figures, refresh); Reach Guard and Account Health.
- **Screencast:** sc-04-insights (screencast-scripts.md)

**Justification text for the submission box:**

> We show each seller how their own account and posts perform, and warn them when reach drops so they can slow their automations. We need instagram_business_manage_insights to read the account and media insight metrics Meta provides for the seller's own account. The figures are shown only to that seller, labelled with their source, and never sold, shared or used to profile people. If a seller does not allow this permission the product still works, and the screens say Permission needed.

## Facebook Login for Business

### pages_show_list

- **Used for:** Lists the Facebook Pages the person manages so they can choose which Page to connect.
- **Where in the product:** Connect screen, Facebook section: the Page picker.
- **Screencast:** sc-05-facebook-page (screencast-scripts.md)

**Justification text for the submission box:**

> A seller who also sells through Facebook connects one Page to Bhava. We need pages_show_list to show the Pages the person manages so they choose the right one. We store only the chosen Page.

### pages_manage_metadata

- **Used for:** Subscribes the app to the connected Page's webhook fields, so messages and comments on the Page reach the business.
- **Where in the product:** Connect screen, Facebook section: connected state and webhook status.
- **Screencast:** sc-05-facebook-page (screencast-scripts.md)

**Justification text for the submission box:**

> We need pages_manage_metadata to subscribe our app to the webhook fields of the one Page the seller connected, so the seller's Page messages and comments arrive. We make no other change to the Page and remove the subscription when the seller disconnects.

### pages_messaging

- **Used for:** Receives and sends Messenger messages for the connected Page.
- **Where in the product:** Inbox (Messenger threads next to Instagram ones); Automations on the Page.
- **Screencast:** sc-05-facebook-page (screencast-scripts.md)

**Justification text for the submission box:**

> We need pages_messaging so a seller can answer customers who message their Facebook Page from the same inbox as Instagram. Messages go only to people who messaged the Page first, inside the messaging window, through the same limits and opt-out rules as Instagram.

### pages_read_engagement

- **Used for:** Reads the Page's posts and the comments on them, so comment automations can match the seller's keyword.
- **Where in the product:** Automations on the Page (choose a post, comment trigger).
- **Screencast:** sc-05-facebook-page (screencast-scripts.md)

**Justification text for the submission box:**

> We need pages_read_engagement to read the seller's own Page posts and the comments on them, so the seller can pick a post for an automation and the keyword in a comment can be recognised. We read only the connected Page.

### pages_manage_engagement

- **Used for:** Replies to comments on the connected Page's posts with the seller's own reply text.
- **Where in the product:** Automations on the Page (public reply to a comment).
- **Screencast:** sc-05-facebook-page (screencast-scripts.md)

**Justification text for the submission box:**

> We need pages_manage_engagement to post the seller's own public reply under a comment on the seller's Page post, for example 'Check your messages'. Replies are limited per comment and per hour, and nothing is posted without the seller having set the automation up.

## WhatsApp Business Platform

### whatsapp_business_management

- **Used for:** Lets a business with the WhatsApp add-on connect its own WhatsApp Business account and manage its message templates.
- **Where in the product:** WhatsApp screen: Connect WhatsApp (embedded signup), the number, and the template list.
- **Screencast:** sc-06-whatsapp (screencast-scripts.md)

**Justification text for the submission box:**

> A seller with the WhatsApp add-on connects their own WhatsApp Business account through Meta's embedded signup. We need whatsapp_business_management to read that account and its phone number and to create and read the message templates the seller uses. We touch only the account the seller chose.

### whatsapp_business_messaging

- **Used for:** Sends and receives WhatsApp messages from the business's own number: order updates and replies to customers who agreed to hear from the business.
- **Where in the product:** WhatsApp screen: conversations and the automations that reply there.
- **Screencast:** sc-06-whatsapp (screencast-scripts.md)

**Justification text for the submission box:**

> We need whatsapp_business_messaging so a seller's WhatsApp number can reply to customers who wrote to it, and send approved template messages such as order updates to customers who opted in. Messages outside the 24-hour window use only approved templates, and an opt-out stops all further messages.

## Webhook fields

The webhook fields the code subscribes to, and the permission each needs (src/modules/ig-connect/rules.js):

| Field | Permission |
| --- | --- |
| comments | instagram_business_manage_comments |
| mentions | instagram_business_manage_comments |
| messages | instagram_business_manage_messages |
| messaging_postbacks | instagram_business_manage_messages |
