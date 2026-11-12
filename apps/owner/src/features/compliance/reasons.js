/**
 * The compliance engine's words (PRD 4): what happened to a message and why, for every reason code the API sends.
 * The codes are REASON_CODES and OUTCOMES in src/contracts/compliance.js, and the English is the console's
 * (console/src/features/compliance/reasons.json); a test keeps all three in step. Every screen that shows a refusal
 * from the engine (a reply that did not go, a test send, a save the rules refused) says it with these lines, so a
 * seller reads the reason the server gave, never a bare code and never a crash.
 *
 * Pure: no React, so the server-side tests can import it too.
 */

/** Badge tone for each outcome. */
export const OUTCOME_TONES = Object.freeze({
  queued: 'primary',
  held: 'warn',
  sent: 'good',
  sent_fallback: 'good',
  unknown: 'warn',
  failed: 'bad',
  cancelled: 'neutral',
  expired: 'neutral',
  skipped: 'neutral',
  would_send: 'primary',
});
export const OUTCOME_CODES = Object.freeze(Object.keys(OUTCOME_TONES));

const OUTCOME_LABELS = {
  en: {
    queued: 'Queued', held: 'Held', sent: 'Sent', sent_fallback: 'Sent as text', unknown: 'Not confirmed', failed: 'Failed',
    cancelled: 'Cancelled', expired: 'Expired', skipped: 'Skipped', would_send: 'Dry run', noted: 'Noted',
  },
  hi: {
    queued: 'कतार में', held: 'रोका गया', sent: 'भेजा गया', sent_fallback: 'टेक्स्ट के रूप में भेजा', unknown: 'पुष्टि नहीं हुई', failed: 'नहीं गया',
    cancelled: 'रद्द', expired: 'समय निकल गया', skipped: 'छोड़ा गया', would_send: 'ड्राई रन', noted: 'दर्ज',
  },
};

/** One sentence per reason code, as a seller reads it. */
const REASONS = {
  en: {
    queued: 'Waiting its turn to send.',
    held: 'Held until sending can start again.',
    sent: 'Delivered to Instagram.',
    sent_fallback: 'Sent as plain text, because the button was refused.',
    unknown: 'We didn’t get a confirmation, so it won’t be resent.',
    failed: 'This couldn’t be sent.',
    cancelled: 'Cancelled before it went out.',
    expired: 'It waited too long and was dropped.',
    skipped: 'We chose not to send this.',
    would_send: 'Dry run: this would have been sent.',
    'webhook.bad_signature': 'A message claiming to be from Meta failed its security check.',
    'webhook.duplicate': 'Meta told us about this twice. It was handled once.',
    'webhook.malformed': 'Meta sent something we couldn’t read.',
    'tenant.unknown_entry': 'This came for an account that isn’t connected.',
    'api.host_blocked': 'A call to an address that isn’t Meta’s was stopped.',
    unmapped: 'No automation is set up for this post.',
    no_keyword: 'The comment didn’t have one of the keywords.',
    own_account: 'This was your own comment.',
    own_thread: 'This was a reply under your own comment.',
    unsupported_media: 'Comments on ads and Live aren’t answered.',
    test_mode: 'This automation is in Test, and the person isn’t a tester.',
    'automation.draft': 'This automation is still a draft.',
    outside_hours: 'This came in outside the automation’s hours.',
    too_short: 'The comment was too short to act on.',
    optout: 'This person asked not to get automated messages.',
    negative_intent: 'The comment read like a complaint, so no sales link went out.',
    'window.closed': 'It has been more than 24 hours since this person last messaged you.',
    'expired.7d': 'A private reply is only allowed within 7 days of the comment.',
    'expired.public_reply': 'The public reply waited too long to be useful.',
    'followup.no_response': 'A follow-up only goes after the person has replied.',
    'mention.no_window': 'A mention on its own doesn’t allow a DM.',
    'tag.not_allowed': 'That kind of message isn’t allowed outside the 24-hour window.',
    'thread.handoff': 'The person asked for a human, so automation stopped in this chat.',
    'thread.owner_replied': 'You replied yourself, so automation stopped in this chat.',
    'comment.deleted': 'The comment was deleted before the reply went out.',
    'comment.edited': 'The comment was edited, so it no longer asks for this.',
    'recipient.unavailable': 'This person can’t be messaged.',
    'cap.per_comment': 'This comment already got its one reply.',
    'cap.per_media': 'This person was already sent a DM for this post.',
    'cap.per_person_24h': 'This person reached the daily limit of DMs.',
    'cap.mention_7d': 'This person was already sent a DM for a mention this week.',
    'cap.followup': 'This person was already sent a follow-up for this automation.',
    'cap.welcome_once': 'This person was already sent the welcome message.',
    'cap.reply_per_message': 'This message was already answered automatically.',
    'cap.dm_replies_24h': 'This person reached the daily limit of automated replies.',
    'cap.public_reply_media_h': 'This post reached its hourly limit of public replies.',
    'cap.public_reply_tenant_h': 'Your account reached its hourly limit of public replies.',
    'content.too_long': 'The message is over the length limit.',
    'content.financial_request': 'The message asked for card, bank or identity details.',
    'content.button_title': 'The button text is over the limit.',
    'content.bad_variable': 'The message used a variable that doesn’t exist.',
    'content.bhava_promo': 'The message named or linked to the platform that sends it.',
    'link.scheme': 'The link has to start with https.',
    'link.shortener': 'Short links that hide the destination aren’t allowed.',
    'link.not_allowlisted': 'That website isn’t allowed for this link type.',
    'link.redirect': 'The link sends people somewhere else first.',
    'link.blocked': 'That website is blocked.',
    'link.check_failed': 'The link didn’t open when we checked it.',
    'rate.throttled': 'Instagram asked us to slow down, so this is waiting.',
    'rate.usage_header': 'Your account is close to Instagram’s limit, so this is waiting.',
    'rate.slow_mode': 'Slow mode was on, so this waited.',
    'fallback.validation': 'The button was refused, so plain text went instead.',
    'send.unknown_outcome': 'We didn’t get a confirmation, so it won’t be resent.',
    'send.error': 'Instagram refused this message.',
    'paused.automation': 'This automation was paused.',
    'paused.tenant': 'Your automations were paused.',
    'paused.global': 'Bhava paused all messages for a while.',
    'paused.breaker': 'Sending stopped by itself after errors from Instagram.',
    'paused.reconnect': 'Instagram needs reconnecting.',
    'held.review': 'Waiting for a review.',
    'held.dm_limit': 'Your plan’s monthly DM limit was reached.',
    'cancelled.owner': 'You discarded this.',
    'cancelled.optout': 'The person opted out before it went.',
    'token.refreshed': 'Your Instagram connection was renewed.',
    'token.refresh_failed': 'Your Instagram connection couldn’t be renewed.',
    'token.rejected': 'Instagram stopped accepting your connection.',
    'token.deauthorized': 'The connection was removed from Instagram.',
    'gate.access_level': 'Meta hasn’t given this account access yet.',
    'gate.scope_missing': 'A permission is missing from your connection.',
    'gate.privacy_url': 'The privacy page failed its check.',
    'gate.deletion_callback': 'The data deletion address failed its check.',
    'gate.passed': 'All of Meta’s checks passed.',
    'deletion.requested': 'A person asked for their data to be deleted.',
    'deletion.completed': 'A person’s data was deleted.',
    'ai.low_confidence': 'The AI wasn’t sure, so it didn’t answer.',
    'ai.ungrounded': 'The AI had nothing to base an answer on.',
    'wa.no_optin': 'This person hasn’t opted in on WhatsApp.',
  },
  hi: {
    queued: 'भेजे जाने की बारी का इंतज़ार है।',
    held: 'भेजना फिर शुरू होने तक रोका गया है।',
    sent: 'Instagram तक पहुँचा दिया गया।',
    sent_fallback: 'बटन मना हो गया, इसलिए सादा टेक्स्ट भेजा गया।',
    unknown: 'हमें पुष्टि नहीं मिली, इसलिए यह दोबारा नहीं भेजा जाएगा।',
    failed: 'यह भेजा नहीं जा सका।',
    cancelled: 'जाने से पहले रद्द कर दिया गया।',
    expired: 'बहुत देर इंतज़ार हुआ, इसलिए छोड़ दिया गया।',
    skipped: 'हमने इसे न भेजने का फ़ैसला किया।',
    would_send: 'ड्राई रन: यह भेजा जाता।',
    'webhook.bad_signature': 'Meta के नाम से आया एक संदेश सुरक्षा जाँच में फ़ेल हुआ।',
    'webhook.duplicate': 'Meta ने यह हमें दो बार बताया। इसे एक ही बार संभाला गया।',
    'webhook.malformed': 'Meta ने कुछ ऐसा भेजा जिसे हम पढ़ नहीं सके।',
    'tenant.unknown_entry': 'यह ऐसे अकाउंट के लिए आया जो जुड़ा नहीं है।',
    'api.host_blocked': 'ऐसे पते पर कॉल रोकी गई जो Meta का नहीं है।',
    unmapped: 'इस पोस्ट के लिए कोई ऑटोमेशन सेट नहीं है।',
    no_keyword: 'कमेंट में कोई कीवर्ड नहीं था।',
    own_account: 'यह आपका अपना कमेंट था।',
    own_thread: 'यह आपके अपने कमेंट के नीचे का जवाब था।',
    unsupported_media: 'विज्ञापनों और Live पर आए कमेंट का जवाब नहीं दिया जाता।',
    test_mode: 'यह ऑटोमेशन टेस्ट में है, और यह व्यक्ति टेस्टर नहीं है।',
    'automation.draft': 'यह ऑटोमेशन अभी ड्राफ़्ट है।',
    outside_hours: 'यह ऑटोमेशन के समय के बाहर आया।',
    too_short: 'कमेंट इतना छोटा था कि उस पर कुछ नहीं किया जा सका।',
    optout: 'इस व्यक्ति ने ऑटोमेटेड संदेश न भेजने को कहा है।',
    negative_intent: 'कमेंट शिकायत जैसा लगा, इसलिए बिक्री का लिंक नहीं भेजा गया।',
    'window.closed': 'इस व्यक्ति के आख़िरी संदेश को 24 घंटे से ज़्यादा हो गए हैं।',
    'expired.7d': 'प्राइवेट जवाब कमेंट के 7 दिन के अंदर ही भेजा जा सकता है।',
    'expired.public_reply': 'पब्लिक जवाब इतनी देर रुका कि अब काम का नहीं रहा।',
    'followup.no_response': 'फ़ॉलो-अप तभी जाता है जब व्यक्ति ने जवाब दिया हो।',
    'mention.no_window': 'सिर्फ़ मेंशन से DM भेजने की अनुमति नहीं मिलती।',
    'tag.not_allowed': '24 घंटे की अवधि के बाहर इस तरह का संदेश भेजने की अनुमति नहीं है।',
    'thread.handoff': 'व्यक्ति ने इंसान से बात करनी चाही, इसलिए इस चैट में ऑटोमेशन रुक गया।',
    'thread.owner_replied': 'आपने ख़ुद जवाब दिया, इसलिए इस चैट में ऑटोमेशन रुक गया।',
    'comment.deleted': 'जवाब जाने से पहले कमेंट हटा दिया गया।',
    'comment.edited': 'कमेंट बदल दिया गया, इसलिए अब वह यह नहीं माँगता।',
    'recipient.unavailable': 'इस व्यक्ति को संदेश नहीं भेजा जा सकता।',
    'cap.per_comment': 'इस कमेंट को पहले ही अपना एक जवाब मिल चुका है।',
    'cap.per_media': 'इस व्यक्ति को इस पोस्ट के लिए पहले ही DM भेजा जा चुका है।',
    'cap.per_person_24h': 'यह व्यक्ति रोज़ की DM सीमा तक पहुँच गया है।',
    'cap.mention_7d': 'इस व्यक्ति को इस हफ़्ते मेंशन के लिए पहले ही DM भेजा जा चुका है।',
    'cap.followup': 'इस व्यक्ति को इस ऑटोमेशन का फ़ॉलो-अप पहले ही भेजा जा चुका है।',
    'cap.welcome_once': 'इस व्यक्ति को स्वागत संदेश पहले ही भेजा जा चुका है।',
    'cap.reply_per_message': 'इस संदेश का जवाब पहले ही अपने-आप दिया जा चुका है।',
    'cap.dm_replies_24h': 'यह व्यक्ति रोज़ के ऑटोमेटेड जवाबों की सीमा तक पहुँच गया है।',
    'cap.public_reply_media_h': 'इस पोस्ट पर पब्लिक जवाबों की घंटे की सीमा पूरी हो गई है।',
    'cap.public_reply_tenant_h': 'आपके अकाउंट पर पब्लिक जवाबों की घंटे की सीमा पूरी हो गई है।',
    'content.too_long': 'संदेश लंबाई की सीमा से ज़्यादा है।',
    'content.financial_request': 'संदेश में कार्ड, बैंक या पहचान की जानकारी माँगी गई थी।',
    'content.button_title': 'बटन का टेक्स्ट सीमा से ज़्यादा है।',
    'content.bad_variable': 'संदेश में ऐसा वेरिएबल था जो मौजूद नहीं है।',
    'content.bhava_promo': 'संदेश में उस प्लेटफ़ॉर्म का नाम या लिंक था जो इसे भेजता है।',
    'link.scheme': 'लिंक https से शुरू होना चाहिए।',
    'link.shortener': 'ऐसे छोटे लिंक की अनुमति नहीं है जो असली पता छिपाते हैं।',
    'link.not_allowlisted': 'इस तरह के लिंक के लिए वह वेबसाइट अनुमति में नहीं है।',
    'link.redirect': 'लिंक लोगों को पहले कहीं और भेजता है।',
    'link.blocked': 'वह वेबसाइट ब्लॉक है।',
    'link.check_failed': 'जाँच के समय लिंक नहीं खुला।',
    'rate.throttled': 'Instagram ने धीमे चलने को कहा, इसलिए यह इंतज़ार कर रहा है।',
    'rate.usage_header': 'आपका अकाउंट Instagram की सीमा के पास है, इसलिए यह इंतज़ार कर रहा है।',
    'rate.slow_mode': 'स्लो मोड चालू था, इसलिए यह रुका रहा।',
    'fallback.validation': 'बटन मना हो गया, इसलिए उसकी जगह सादा टेक्स्ट गया।',
    'send.unknown_outcome': 'हमें पुष्टि नहीं मिली, इसलिए यह दोबारा नहीं भेजा जाएगा।',
    'send.error': 'Instagram ने यह संदेश मना कर दिया।',
    'paused.automation': 'यह ऑटोमेशन रोका गया था।',
    'paused.tenant': 'आपके ऑटोमेशन रोके गए थे।',
    'paused.global': 'Bhava ने कुछ समय के लिए सभी संदेश रोक दिए।',
    'paused.breaker': 'Instagram की गड़बड़ियों के बाद भेजना अपने-आप रुक गया।',
    'paused.reconnect': 'Instagram को फिर से जोड़ना है।',
    'held.review': 'रिव्यू का इंतज़ार है।',
    'held.dm_limit': 'आपके प्लान की महीने की DM सीमा पूरी हो गई।',
    'cancelled.owner': 'आपने इसे हटा दिया।',
    'cancelled.optout': 'भेजे जाने से पहले व्यक्ति ने मना कर दिया।',
    'token.refreshed': 'आपका Instagram कनेक्शन नया हो गया।',
    'token.refresh_failed': 'आपका Instagram कनेक्शन नया नहीं हो सका।',
    'token.rejected': 'Instagram ने आपका कनेक्शन मानना बंद कर दिया।',
    'token.deauthorized': 'Instagram की तरफ़ से कनेक्शन हटा दिया गया।',
    'gate.access_level': 'Meta ने अभी इस अकाउंट को अनुमति नहीं दी है।',
    'gate.scope_missing': 'आपके कनेक्शन में एक अनुमति नहीं है।',
    'gate.privacy_url': 'प्राइवेसी पेज जाँच में फ़ेल हुआ।',
    'gate.deletion_callback': 'डेटा हटाने का पता जाँच में फ़ेल हुआ।',
    'gate.passed': 'Meta की सभी जाँचें पास हो गईं।',
    'deletion.requested': 'एक व्यक्ति ने अपना डेटा हटाने को कहा।',
    'deletion.completed': 'एक व्यक्ति का डेटा हटा दिया गया।',
    'ai.low_confidence': 'AI पक्का नहीं था, इसलिए उसने जवाब नहीं दिया।',
    'ai.ungrounded': 'AI के पास जवाब का कोई आधार नहीं था।',
    'wa.no_optin': 'इस व्यक्ति ने WhatsApp पर सहमति नहीं दी है।',
  },
};
export const REASON_CODES = Object.freeze(Object.keys(REASONS.en));

/** What kind of thing a log row is about. */
const KINDS = {
  en: {
    private_reply: 'Private reply', dm: 'DM', public_reply: 'Public reply', thread: 'Chat', handoff: 'Chat', negative_comment: 'Comment', optout: 'Opt-out',
    optin: 'Opt-in', webhook: 'From Meta', malformed: 'From Meta', undecryptable: 'From Meta', token: 'Connection', gate: 'Meta’s checks', pause: 'Pause',
    usage: 'Usage', data: 'Data request',
  },
  hi: {
    private_reply: 'प्राइवेट जवाब', dm: 'DM', public_reply: 'पब्लिक जवाब', thread: 'चैट', handoff: 'चैट', negative_comment: 'कमेंट', optout: 'मना करना',
    optin: 'सहमति', webhook: 'Meta से', malformed: 'Meta से', undecryptable: 'Meta से', token: 'कनेक्शन', gate: 'Meta की जाँचें', pause: 'रोक',
    usage: 'इस्तेमाल', data: 'डेटा का अनुरोध',
  },
};
export const KIND_CODES = Object.freeze(Object.keys(KINDS.en));

const prefixed = (prefix, table) => Object.fromEntries(Object.entries(table).map(([code, text]) => [`${prefix}${code}`, text]));

/** The lines as the compliance feature registers them, under its own keys. */
export const REASON_STRINGS = Object.freeze({
  en: { ...prefixed('compliance.outcome.', OUTCOME_LABELS.en), ...prefixed('compliance.reason.', REASONS.en), ...prefixed('compliance.kind.', KINDS.en) },
  hi: { ...prefixed('compliance.outcome.', OUTCOME_LABELS.hi), ...prefixed('compliance.reason.', REASONS.hi), ...prefixed('compliance.kind.', KINDS.hi) },
});

export const isOutcome = (code) => Object.hasOwn(OUTCOME_TONES, String(code ?? ''));
export const isReason = (code) => Object.hasOwn(REASONS.en, String(code ?? ''));

/** { label, tone } for a badge. A row that records an event carries a reason code here and is simply noted; an unknown code reads as itself. */
export function describeOutcome(t, code) {
  if (isOutcome(code)) return { label: t(`compliance.outcome.${code}`), tone: OUTCOME_TONES[code] };
  if (isReason(code)) return { label: t('compliance.outcome.noted'), tone: 'neutral' };
  return { label: String(code ?? ''), tone: 'neutral' };
}

/** One sentence a seller can read, or '' for no reason. A code this build does not know yet is shown as it is, never hidden. */
export function describeReason(t, code) {
  if (!code) return '';
  return isReason(code) ? t(`compliance.reason.${code}`) : String(code);
}

/** A log row's kind, in words. One this build does not know still reads as a word. */
export function describeKind(t, kind) {
  if (Object.hasOwn(KINDS.en, String(kind ?? ''))) return t(`compliance.kind.${kind}`);
  const words = String(kind ?? '').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
