/** Checks a DM against Meta's limits (PRD 4.3 rows 11 to 13). Throws code 100, as Graph does, naming the parameter. */
import { ERRORS, graphError } from './constants.mjs';

const MEDIA_ATTACHMENTS = new Set(['image', 'video', 'audio', 'file']);
const chars = (s) => [...s].length;
const invalid = (param, rule) => graphError(ERRORS.INVALID_PARAM, `(#100) Param ${param} ${rule}`);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

function checkTitle(title, max, param) {
  if (typeof title !== 'string' || !title.trim()) throw invalid(param, 'must be a non-empty string');
  if (chars(title) > max) throw invalid(param, `must be at most ${max} characters`);
}

function checkButtons(buttons, limits) {
  const param = 'message[attachment][payload][buttons]';
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > limits.buttonsMax) throw invalid(param, `must hold 1 to ${limits.buttonsMax} buttons`);
  buttons.forEach((button, i) => {
    const at = `${param}[${i}]`;
    checkTitle(button?.title, limits.buttonTitleChars, `${at}[title]`);
    if (button.type === 'web_url') {
      if (!isHttpUrl(button.url)) throw invalid(`${at}[url]`, 'must be an http or https URL');
    } else if (button.type === 'postback') {
      if (typeof button.payload !== 'string' || !button.payload) throw invalid(`${at}[payload]`, 'must be a non-empty string');
      if (chars(button.payload) > limits.postbackPayloadChars) throw invalid(`${at}[payload]`, `must be at most ${limits.postbackPayloadChars} characters`);
    } else {
      throw invalid(`${at}[type]`, 'must be web_url or postback');
    }
  });
}

function checkAttachment(attachment, limits) {
  if (!isObject(attachment)) throw invalid('message[attachment]', 'must be an object');
  if (MEDIA_ATTACHMENTS.has(attachment.type)) {
    if (!isHttpUrl(attachment.payload?.url)) throw invalid('message[attachment][payload][url]', 'must be an http or https URL');
    return;
  }
  if (attachment.type !== 'template') throw invalid('message[attachment][type]', 'is not supported');
  const { payload } = attachment;
  if (payload?.template_type !== 'button') throw invalid('message[attachment][payload][template_type]', 'must be button');
  if (typeof payload.text !== 'string' || !payload.text.trim()) throw invalid('message[attachment][payload][text]', 'must be a non-empty string');
  if (chars(payload.text) > limits.buttonTextChars) throw invalid('message[attachment][payload][text]', `must be at most ${limits.buttonTextChars} characters`);
  checkButtons(payload.buttons, limits);
}

function checkQuickReplies(quickReplies, limits) {
  if (!Array.isArray(quickReplies) || quickReplies.length < 1 || quickReplies.length > limits.quickRepliesMax) throw invalid('message[quick_replies]', `must hold 1 to ${limits.quickRepliesMax} replies`);
  quickReplies.forEach((reply, i) => {
    const at = `message[quick_replies][${i}]`;
    if (reply?.content_type !== 'text') throw invalid(`${at}[content_type]`, 'must be text');
    checkTitle(reply.title, limits.quickReplyTitleChars, `${at}[title]`);
    if (typeof reply.payload !== 'string' || !reply.payload) throw invalid(`${at}[payload]`, 'must be a non-empty string');
  });
}

export function validateMessage(message, limits) {
  if (!isObject(message)) throw invalid('message', 'must be an object');
  const { text, attachment, quick_replies: quickReplies } = message;
  if ((text === undefined) === (attachment === undefined)) throw invalid('message', 'must hold exactly one of text or attachment');
  if (text !== undefined) {
    if (typeof text !== 'string' || !text.trim()) throw invalid('message[text]', 'must be a non-empty string');
    if (Buffer.byteLength(text, 'utf8') > limits.textBytes) throw invalid('message[text]', `must be at most ${limits.textBytes} bytes`);
  } else {
    checkAttachment(attachment, limits);
  }
  if (quickReplies !== undefined) checkQuickReplies(quickReplies, limits);
}
