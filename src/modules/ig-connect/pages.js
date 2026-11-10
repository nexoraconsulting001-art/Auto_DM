import { html, raw } from '../../views/html.js';
import { storeLayout } from '../../views/store.js';
import { RETENTION_DAYS } from './repo.js';
import { SCOPE_BASIC, SCOPE_COMMENTS, SCOPE_INSIGHTS, SCOPE_MESSAGES } from './rules.js';

/** Bhava's own pages in the seller design system. Mobile first; no script. Nothing here is ever shown on a buyer page except sellerPrivacyPage. */
const STYLE = raw(`
:root{--ground:#F6F5F1;--card:#fff;--ink:#16152B;--muted:#55546B;--line:#E2E0D8;--primary:#3B2FC9;--accent:#F5B83D;--good:#17694A;--bad:#A3261B;--display:Unbounded,system-ui,sans-serif;--body:Figtree,system-ui,-apple-system,'Segoe UI',sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:400 16px/1.55 var(--body);overflow-wrap:anywhere}
main,header.top{max-width:720px;margin:0 auto;padding:16px}
header.top{display:flex;align-items:center;gap:10px;padding-top:20px}
header.top svg{width:32px;height:32px;flex:none}
header.top strong{font:700 20px/1 var(--display)}
h1{font:700 26px/1.2 var(--display);margin:8px 0 12px}
h2{font:600 17px/1.3 var(--display);margin:0 0 8px}
p{margin:0 0 12px}
ul,ol{margin:0 0 12px;padding-left:20px}
a{color:var(--primary)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 12px}
.muted{color:var(--muted)}
.fine{color:var(--muted);font-size:14px}
.ok{color:var(--good);font-weight:600}
.bad{color:var(--bad);font-weight:600}
table{border-collapse:collapse;width:100%;font-size:15px}
th,td{text-align:left;padding:8px 6px;border-top:1px solid var(--line);vertical-align:top}
th{font-weight:600;white-space:nowrap}
.scope{display:block;font-weight:600}
label{display:block;margin:0 0 12px;font-weight:600}
input{display:block;width:100%;min-height:44px;margin-top:4px;padding:8px 12px;border:1px solid var(--muted);border-radius:10px;font:inherit}
button{min-height:44px;padding:0 20px;border:0;border-radius:999px;background:var(--primary);color:#fff;font:600 16px var(--body);cursor:pointer}
button.quiet{background:#ECEAFD;color:#2C2399}
form{margin:8px 0 0}
.notice{border-left:4px solid var(--accent)}
.error{color:var(--bad);font-weight:600}
`);

const MARK = raw(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="7 7 52 52" aria-hidden="true"><path fill="#3B2FC9" d="M8 12a4 4 0 0 1 4-4h22.3a4 4 0 0 1 2.9 1.2l19.6 19.6a4 4 0 0 1 0 5.7L34.5 56.8a4 4 0 0 1-5.7 0L9.2 37.2A4 4 0 0 1 8 34.3z"/><path fill="#F5B83D" d="M18.5 13.5h8.5a5 5 0 0 1 5 5v4.5a5 5 0 0 1-5 5h-5.5l-5 5v-5.1a5 5 0 0 1-3-4.9v-4.5a5 5 0 0 1 5-5z"/></svg>`);

function bhavaPage({ title, body, description = '' }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700&family=Unbounded:wght@600;700&display=swap">
<style>${STYLE}</style>
</head>
<body>
<header class="top">${MARK}<strong>Bhava</strong></header>
<main>${body}</main>
</body>
</html>`;
}

/** A short page for something that went wrong outside the console. */
export function messagePage(res, status, { title, text }) {
  res.status(status).type('html').send(String(bhavaPage({ title, body: html`<h1>${title}</h1><div class="card"><p>${text}</p></div>` })));
}

const { rawWebhooks, messages, whyNoDm } = RETENTION_DAYS;

/** Bhava's policy, on Bhava's own address: the URL registered with Meta. Public, with no sign-in and nothing that varies by visitor. */
export function bhavaPrivacyPage({ config }) {
  const contact = config.privacyContactEmail || process.env.PRIVACY_CONTACT_EMAIL || '';
  const body = html`
<h1>Privacy policy</h1>
<p class="muted">Bhava helps businesses answer people on Instagram and Facebook, using only Meta’s official tools. This page says what we receive, what we do with it, and how to have it deleted.</p>

<section class="card">
  <h2>What we receive</h2>
  <ul>
    <li><strong>From a business that connects its account:</strong> the account’s id and username, the permissions its owner granted, and an access token, which we store encrypted.</li>
    <li><strong>From people who interact with that business:</strong> comments on its posts and reels, messages sent to it, button taps, story replies and mentions, with the id Instagram gives that person for that business. The person’s username is kept only in that business’s inbox.</li>
    <li><strong>About the business’s content:</strong> the id, caption and thumbnail of posts and reels. Story media stays with Instagram. We keep a reference to it and never download or re-host it.</li>
  </ul>
</section>

<section class="card">
  <h2>What we do with it</h2>
  <p>We use it only to answer the person on behalf of the business they contacted, to show that business its own inbox and results, and to keep within Meta’s rules, such as limits and opt-outs.</p>
  <p>We never sell or license this data, never use it for advertising, and never share one business’s data with another. We never post to your account and never ask for your Instagram password.</p>
</section>

<section class="card">
  <h2>How long we keep it</h2>
  <table>
    <thead><tr><th scope="col">Data</th><th scope="col">Kept for</th></tr></thead>
    <tbody>
      <tr><td>Raw events from Meta</td><td>${rawWebhooks} days</td></tr>
      <tr><td>Comment and message text, and inbox usernames</td><td>${messages} days</td></tr>
      <tr><td>Why someone did or didn’t get a message</td><td>${whyNoDm} days</td></tr>
      <tr><td>Our decision log, which holds no names or message text</td><td>13 months</td></tr>
      <tr><td>Opt-outs, as a one-way code, so that we keep honouring them</td><td>While the business is active</td></tr>
    </tbody>
  </table>
</section>

<section class="card" id="deletion">
  <h2>How to delete your data</h2>
  <p><strong>If you connected an account to Bhava:</strong> open Instagram, go to Settings, then Apps and websites, remove Bhava, and choose to delete your data. Meta tells us, and we immediately delete your access token and stop your automations. We then delete your account’s Instagram data within 30 days. You get a confirmation code and a link that shows the progress.</p>
  <p><strong>If you messaged or commented on a business that uses Bhava:</strong> ask that business, or write to us${contact ? html` at <a href="mailto:${contact}">${contact}</a>` : ' through the contact details on our website'}. We delete it within 30 days. Replying STOP also ends messages from that business.</p>
</section>

<section class="card">
  <h2>Keeping it safe</h2>
  <p>Tokens are encrypted, each business can only reach its own data, and names and message text stay out of our system logs. If a security incident affects this data, we report it to Meta as soon as practicable.</p>
</section>
${contact ? html`<p class="fine">Questions: <a href="mailto:${contact}">${contact}</a></p>` : ''}`;
  return bhavaPage({ title: 'Privacy policy | Bhava', description: 'What Bhava receives from Instagram and Facebook, how it is used, and how to delete it.', body });
}

/** The same promises in the business's own brand, for its buyers. No mention of Bhava: a buyer only ever sees the seller. */
export function sellerPrivacyPage({ settings }) {
  const name = settings.store_name;
  const whatsapp = settings.support_whatsapp;
  const body = html`
<section class="auth" style="max-width:680px">
  <h1>Privacy</h1>
  <p>When you comment on ${name}’s posts or message ${name} on Instagram or Facebook, we receive what you wrote and the id Instagram or Facebook gives you for this business. We use it only to answer you and to look after your order.</p>
  <h2>What we don’t do</h2>
  <p>We never sell your data or use it for advertising, and we never ask for your Instagram password.</p>
  <h2>How long we keep it</h2>
  <p>Comments and messages, and your Instagram username, are deleted after ${messages} days. If you ask us to stop messaging you by replying STOP, we keep a one-way code so that we can keep honouring it.</p>
  <h2>How to delete your data</h2>
  <p>Ask us to delete what we hold about you${whatsapp ? html` on WhatsApp at ${whatsapp}` : ''}, and we will do so within 30 days. Replying STOP in any message also ends messages from us.</p>
</section>`;
  return storeLayout({ settings, user: null, title: 'Privacy', body });
}

/** What Meta links to from a deletion request. */
export function deletionStatusPage({ status, requestedAt, completedAt }) {
  const done = status === 'completed';
  const day = (at) => new Date(at).toUTCString().slice(5, 16);
  const body = html`
<h1>Data deletion</h1>
<div class="card">
  <p class="${done ? 'ok' : ''}">${done ? 'Your Instagram data has been deleted.' : 'We’re deleting your Instagram data.'}</p>
  <p class="muted">Requested on ${day(requestedAt)}.${done ? html` Finished on ${day(completedAt)}.` : ' Your access token is already deleted and your automations have stopped. The rest is finished within 30 days.'}</p>
</div>`;
  return bhavaPage({ title: 'Data deletion | Bhava', body });
}

export function reviewSignInPage({ error = '' }) {
  const body = html`
<h1>Meta App Review</h1>
<p class="muted">Sign in with the review number and code given in the submission.</p>
<form class="card" method="post" action="/review/login">
  <label>Mobile number<input name="phone" type="tel" inputmode="numeric" autocomplete="off" required></label>
  <label>Review code<input name="code" type="password" autocomplete="off" required></label>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
  <button type="submit">Sign in</button>
</form>`;
  return bhavaPage({ title: 'App Review | Bhava', body });
}

const OUTCOMES = Object.freeze({
  connected: 'Instagram is connected.',
  disconnected: 'Instagram is disconnected. The access token has been deleted.',
  denied: 'You chose not to connect, so nothing was changed.',
  taken: 'This Instagram account is connected to another business on Bhava.',
  missing_scopes: 'Connected, but a permission Bhava needs wasn’t granted. Connect again and allow every permission.',
  failed: 'Instagram didn’t finish the connection. Nothing was changed. Try again.',
  forbidden: 'This account isn’t allowed to connect Instagram.',
});

const PERMISSIONS = [
  [SCOPE_BASIC, 'Reads the account’s id, username and media, so a seller can pick a post or reel.'],
  [SCOPE_COMMENTS, 'Receives comments so a keyword can start a reply, and replies to a comment publicly.'],
  [SCOPE_MESSAGES, 'Sends the private reply to someone who commented, and answers people who message the business.'],
  [SCOPE_INSIGHTS, 'Shows the seller how their posts and reels are doing. Without it, automations run in slow mode.'],
];

const GATE_NAMES = Object.freeze({
  'gate.access_level': 'Account allowed by the app’s access level',
  'gate.scope_missing': 'Messages and comments permissions granted',
  'gate.privacy_url': 'Privacy policy reachable',
  'gate.deletion_callback': 'Data deletion callback reachable',
  'gate.passed': 'Ready to go live',
});

const yesNo = (ok, yes = 'Yes', no = 'No') => html`<span class="${ok ? 'ok' : 'bad'}">${ok ? yes : no}</span>`;
const timeLabel = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/** The whole flow on one page: connect, what was granted, webhooks, what the system decided, privacy and deletion, disconnect. */
export function reviewPage({ connection, gates, decisions, csrf, outcome, deletionUrl }) {
  const connected = connection.status === 'active';
  const message = OUTCOMES[outcome];
  const hidden = html`<input type="hidden" name="_csrf" value="${csrf}">`;
  const body = html`
<h1>Meta App Review</h1>
<p class="muted">This business exists for review. Each step below shows the real product working on it.</p>
${message ? html`<p class="card notice" role="status">${message}</p>` : ''}

<section class="card">
  <h2>1. Connect an Instagram professional account</h2>
  ${connected
    ? html`<p>Connected as <strong>@${connection.username}</strong>. Connection health: <strong>${connection.health}</strong>.${connection.tokenExpiresAt ? html` The access token is valid until ${timeLabel(connection.tokenExpiresAt)} UTC and is refreshed automatically.` : ''}</p>`
    : html`<p>${connection.status === 'not_connected' ? 'No account is connected yet.' : 'The connection stopped working. Connect again.'} You sign in on Instagram itself. Bhava never sees your password.</p>`}
  <form method="post" action="/review/connect">${hidden}<button type="submit">${connected ? 'Connect again' : 'Connect Instagram'}</button></form>
</section>

<section class="card">
  <h2>2. Permissions requested</h2>
  <table>
    <thead><tr><th scope="col">Permission and why Bhava needs it</th><th scope="col">Granted</th></tr></thead>
    <tbody>${PERMISSIONS.map(([scope, why]) => html`<tr><td><span class="scope">${scope}</span>${why}</td><td>${yesNo(connection.scopes.includes(scope))}</td></tr>`)}</tbody>
  </table>
</section>

<section class="card">
  <h2>3. Webhooks</h2>
  <p>On connecting, this account is subscribed to comments, messages, message button taps and mentions. Subscribed: ${yesNo(connection.webhooksSubscribed)}</p>
</section>

<section class="card">
  <h2>4. Try it</h2>
  <p>Create an automation in the <a href="/admin">console</a>, then comment its keyword on that post or reel from another account. A private reply is sent, and the decision appears here.</p>
  ${decisions.length
    ? html`<table>
        <thead><tr><th scope="col">Time (UTC)</th><th scope="col">Decision</th></tr></thead>
        <tbody>${decisions.map((row) => html`<tr><td>${timeLabel(row.created_at)}</td><td>${row.decision}${row.reason ? ` (${row.reason})` : ''}</td></tr>`)}</tbody>
      </table>`
    : html`<p class="muted">Nothing yet.</p>`}
</section>

<section class="card">
  <h2>5. Ready to go live</h2>
  <ul>${gates.map((gate) => html`<li>${GATE_NAMES[gate.code]}: ${yesNo(gate.passed)}</li>`)}</ul>
</section>

<section class="card">
  <h2>6. Privacy and data deletion</h2>
  <p>Read the <a href="/privacy">privacy policy</a>. When the app is removed on Instagram, Meta calls the deauthorize callback: the token is deleted and sending stops at once. A data deletion request goes to <span class="fine">${deletionUrl}</span>, and answers with a confirmation code and a page showing its progress.</p>
  ${connection.status === 'not_connected' ? '' : html`<form method="post" action="/review/disconnect">${hidden}<button class="quiet" type="submit">Disconnect Instagram</button></form>`}
</section>

<form method="post" action="/logout">${hidden}<button class="quiet" type="submit">Sign out</button></form>`;
  return bhavaPage({ title: 'App Review | Bhava', body });
}
