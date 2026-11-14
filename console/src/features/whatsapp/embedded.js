/**
 * Meta's embedded sign-up for WhatsApp, in the browser. The server hands out the app, the configuration and a one-time state
 * (whatsapp.connectStart); Meta's dialog answers with a code and the ids of the account and number, and the server finishes it
 * (whatsapp.connectFinish). Nothing here handles an access token. Tests replace `loadSdk` with their own.
 */
const SDK = 'https://connect.facebook.net/en_US/sdk.js';
const META_ORIGINS = Object.freeze(['https://www.facebook.com', 'https://web.facebook.com']);

export function loadSdk(doc = document, win = window) {
  if (win.FB) return Promise.resolve(win.FB);
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = SDK;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => (win.FB ? resolve(win.FB) : reject(new Error('Meta’s sign-up did not load.')));
    script.onerror = () => reject(new Error('We could not reach Meta. Check your connection and try again.'));
    doc.head.appendChild(script);
  });
}

/** What Meta's page posts back when the owner finishes: only a message from Meta's own origin, of the sign-up kind, counts. */
export function parseSignupMessage(event) {
  if (!META_ORIGINS.includes(event.origin)) return null;
  let data = event.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data?.type !== 'WA_EMBEDDED_SIGNUP') return null;
  if (data.event === 'FINISH') return { done: true, wabaId: String(data.data?.waba_id ?? ''), phoneNumberId: String(data.data?.phone_number_id ?? '') };
  if (data.event === 'CANCEL') return { done: false };
  return null;
}

/** Opens the dialog and resolves { code, wabaId, phoneNumberId }, or null when the owner closes it. */
export async function runEmbeddedSignup({ appId, configId }, { sdk = loadSdk, win = window } = {}) {
  const FB = await sdk();
  FB.init({ appId, autoLogAppEvents: false, xfbml: false, version: 'v21.0' });
  return new Promise((resolve, reject) => {
    let code = '';
    let ids = null;
    const settle = (value) => {
      win.removeEventListener('message', listen);
      resolve(value);
    };
    const listen = (event) => {
      const message = parseSignupMessage(event);
      if (!message) return;
      if (!message.done) return settle(null);
      ids = message;
      if (code) settle({ code, wabaId: ids.wabaId, phoneNumberId: ids.phoneNumberId });
      return undefined;
    };
    win.addEventListener('message', listen);
    FB.login((response) => {
      code = response?.authResponse?.code ?? '';
      if (!code) {
        win.removeEventListener('message', listen);
        return resolve(null);
      }
      if (ids) settle({ code, wabaId: ids.wabaId, phoneNumberId: ids.phoneNumberId });
      return undefined;
    }, { config_id: configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: '3' } });
    setTimeout(() => {
      win.removeEventListener('message', listen);
      reject(new Error('The WhatsApp sign-up took too long. Please try again.'));
    }, 10 * 60_000);
  });
}
