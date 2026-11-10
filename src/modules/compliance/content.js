/**
 * The content rules (PRD 4.10), used when a template is saved and again at send. Owned by the compliance track;
 * automations, links and the inbox import these two functions from here.
 */

const VARIABLES = Object.freeze({ first_name: 'firstName', url: 'url' });

/** Fills {first_name} and {url}. Anything else stays as written, and checkContent reports it as content.bad_variable. */
export function fillTemplate(template, { firstName = '', url = '' } = {}) {
  const values = { firstName, url };
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(VARIABLES, name) ? values[VARIABLES[name]] : whole));
}

/**
 * Every rule a message breaks, as [{ reason, message, field }], empty when it is fine.
 * input: { text, buttonTitle?, quickReplies?, filled? }. filled is true at send, after the variables are filled.
 * A stub until the compliance track fills it in: it reports nothing.
 */
export function checkContent() {
  return [];
}
