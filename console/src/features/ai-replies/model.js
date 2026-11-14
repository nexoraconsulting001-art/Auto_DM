/** Pure rules of the AI replies screen (PRD 6.11): the limits the server states, and the words for what the add-on did. */
export const AI_THRESHOLD = Object.freeze({ min: 0.5, max: 1, step: 0.05 });
export const QUESTION_MAX = 1000;
export const FAQ_LIMITS = Object.freeze({ question: 300, answer: 1000 });
export const OUTCOMES = Object.freeze(['answered', 'handed_off', 'dropped', 'failed', 'test']);

export const OUTCOME_WORDS = Object.freeze({
  answered: { label: 'Answered', tone: 'good' },
  handed_off: { label: 'Handed to you', tone: 'warn' },
  dropped: { label: 'Not sent', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
  test: { label: 'Test', tone: 'neel' },
});

/** Why a test answer would not have been sent, in words. Unknown reasons are shown as a plain sentence, never as a code. */
export const REASON_WORDS = Object.freeze({
  'ai.low_confidence': 'The answer was below your confidence level, so a person would reply.',
  'ai.ungrounded': 'The answer was not backed by your FAQ or products, so a person would reply.',
  'ai.handoff': 'This kind of question is always handed to a person.',
  'ai.provider_failed': 'The AI service did not answer, so a person would reply.',
});
export const reasonWords = (reason) => REASON_WORDS[reason] ?? 'A person would reply to this one.';

export const percent = (score) => (typeof score === 'number' ? `${Math.round(score * 100)}%` : 'No score');

export function checkFaq({ question, answer }) {
  const found = {};
  if (!question.trim()) found.question = 'Write the question.';
  else if (question.trim().length > FAQ_LIMITS.question) found.question = `Use ${FAQ_LIMITS.question} characters or fewer.`;
  if (!answer.trim()) found.answer = 'Write the answer.';
  else if (answer.trim().length > FAQ_LIMITS.answer) found.answer = `Use ${FAQ_LIMITS.answer} characters or fewer.`;
  return found;
}

export function checkQuestion(question) {
  if (!question.trim()) return 'Write a question.';
  if (question.trim().length > QUESTION_MAX) return `Use ${QUESTION_MAX} characters or fewer.`;
  return '';
}

export const thresholdOk = (value) => Number.isFinite(value) && value >= AI_THRESHOLD.min && value <= AI_THRESHOLD.max;
