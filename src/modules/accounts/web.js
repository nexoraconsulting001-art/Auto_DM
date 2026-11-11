import { AUTH_PATHS } from '../../contracts/api/index.js';

const ERRORS = Object.freeze({
  denied: 'Google sign-in was cancelled. Try again, or use a WhatsApp code.',
  failed: 'We couldn’t sign you in with Google. Try again, or use a WhatsApp code.',
  expired: 'That sign-in took too long. Start again.',
});

// Bhava's mark (the logo's two shapes); the word beside it is set in the display font.
const MARK = '<svg viewBox="7 7 50 52" width="34" height="34" aria-hidden="true"><path fill="#3B2FC9" d="M8 12a4 4 0 0 1 4-4h22.3a4 4 0 0 1 2.9 1.2l19.6 19.6a4 4 0 0 1 0 5.7L34.5 56.8a4 4 0 0 1-5.7 0L9.2 37.2A4 4 0 0 1 8 34.3z"/><path fill="#F5B83D" d="M18.5 13.5h8.5a5 5 0 0 1 5 5v4.5a5 5 0 0 1-5 5h-5.5l-5 5v-5.1a5 5 0 0 1-3-4.9v-4.5a5 5 0 0 1 5-5z"/></svg>';

/**
 * The web sign-in page on the sign-in host (AUTH_PATHS.signIn): Bhava's, in the Neel and Haldi system. Continue with
 * Google, or a 6-digit code on WhatsApp. There is no password field and no SMS (P-11). The page holds no data: it calls
 * auth.start and auth.verify with transport "cookie" and then opens the console.
 */
export function signInPage({ google = true, error = '' } = {}) {
  const notice = ERRORS[error] ?? '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in · Bhava for Business</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600&family=Unbounded:wght@600&display=swap" rel="stylesheet">
<style>
  :root { --ground:#f6f5f1; --surface:#fff; --ink:#16152b; --ink-2:#4b4a63; --line:#e7e5ee; --neel:#3b2fc9; --neel-deep:#2c2399; --haldi:#f5b83d; --good:#17694a; --bad:#b4432c; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; background:var(--ground); color:var(--ink); font:15px/1.5 Figtree, system-ui, sans-serif; display:flex; align-items:flex-start; justify-content:center; padding:48px 16px; }
  main { width:100%; max-width:400px; background:var(--surface); border:1px solid var(--line); border-radius:24px; padding:28px 24px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:24px; font:600 20px Unbounded, system-ui, sans-serif; }
  h1 { font:600 22px/1.3 Unbounded, system-ui, sans-serif; margin:0 0 6px; }
  p { margin:0 0 20px; color:var(--ink-2); }
  label { display:block; font-weight:600; margin:0 0 6px; }
  input { width:100%; height:52px; border:1px solid var(--line); border-radius:16px; padding:0 16px; font:inherit; font-size:17px; color:var(--ink); }
  input:focus { outline:2px solid var(--neel); outline-offset:1px; }
  button, .google { display:flex; width:100%; height:52px; align-items:center; justify-content:center; gap:8px; border-radius:999px; font:600 16px Figtree, system-ui, sans-serif; cursor:pointer; text-decoration:none; }
  button { border:0; background:var(--neel); color:#fff; margin-top:14px; }
  button:disabled { opacity:.6; cursor:default; }
  .google { border:1px solid var(--line); background:var(--surface); color:var(--ink); }
  .or { display:flex; align-items:center; gap:12px; color:var(--ink-2); margin:20px 0; font-size:13px; }
  .or::before, .or::after { content:''; flex:1; height:1px; background:var(--line); }
  .notice { border-radius:14px; padding:12px 14px; margin-bottom:16px; background:#fde8e6; color:var(--bad); }
  .notice[hidden], form[hidden] { display:none; }
  .small { font-size:13px; color:var(--ink-2); margin-top:14px; }
</style>
</head>
<body>
<main>
  <div class="brand">${MARK}<span>Bhava</span></div>
  <h1>Sign in to your business</h1>
  <p>Use Google, or get a 6-digit code on WhatsApp.</p>
  <div class="notice" id="notice" role="alert"${notice ? '' : ' hidden'}>${notice}</div>
  ${google ? `<a class="google" href="${AUTH_PATHS.googleStart}?target=web">Continue with Google</a><div class="or">or</div>` : ''}
  <form id="phone-form">
    <label for="phone">WhatsApp number</label>
    <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="98765 43210" required>
    <button type="submit">Send code on WhatsApp</button>
  </form>
  <form id="code-form" hidden>
    <label for="code">6-digit code</label>
    <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
    <button type="submit">Sign in</button>
    <p class="small">Didn’t get it? Wait 30 seconds and send it again${google ? ', or continue with Google' : ''}.</p>
  </form>
</main>
<script>
(function () {
  var notice = document.getElementById('notice');
  var phoneForm = document.getElementById('phone-form');
  var codeForm = document.getElementById('code-form');
  var phone = '';
  function say(text) { notice.textContent = text; notice.hidden = !text; }
  function post(path, body) {
    return fetch('/api/v1' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (json) { return { ok: res.ok, json: json }; }); });
  }
  phoneForm.addEventListener('submit', function (event) {
    event.preventDefault();
    phone = document.getElementById('phone').value;
    var button = phoneForm.querySelector('button');
    button.disabled = true;
    post('/auth/start', { phone: phone }).then(function (answer) {
      button.disabled = false;
      if (!answer.ok) return say(answer.json.error || 'Something went wrong. Try again.');
      say('');
      phoneForm.hidden = true;
      codeForm.hidden = false;
      document.getElementById('code').focus();
    }, function () { button.disabled = false; say('You seem to be offline. Try again.'); });
  });
  codeForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = codeForm.querySelector('button');
    button.disabled = true;
    post('/auth/verify', { phone: phone, code: document.getElementById('code').value, transport: 'cookie' }).then(function (answer) {
      button.disabled = false;
      if (!answer.ok) return say(answer.json.error || 'Something went wrong. Try again.');
      window.location.assign('/admin');
    }, function () { button.disabled = false; say('You seem to be offline. Try again.'); });
  });
})();
</script>
</body>
</html>`;
}
