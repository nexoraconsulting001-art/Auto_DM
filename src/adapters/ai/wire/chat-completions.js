/**
 * The "chat completions" wire format, which many model providers speak. A wire format is this much and no more:
 *
 *   name
 *   request({ model, system, user, maxOutputTokens, apiKey }) -> { path, headers, json }
 *   parse(body) -> { text, units, model, refused }        `body` is the parsed 2xx answer; throw nothing, return '' for no text
 *
 * `store: false` asks the provider not to keep the exchange for its own use, where it offers that setting. Whether the
 * chosen provider trains on API traffic is settled in its contract before AI_DRIVER is set (PRD 6.11, to confirm).
 */
export const chatCompletions = {
  name: 'chat_completions',

  request({ model, system, user, maxOutputTokens, apiKey }) {
    return {
      path: '/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      json: {
        model,
        store: false,
        temperature: 0,
        max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      },
    };
  },

  parse(body) {
    const choice = body?.choices?.[0];
    const usage = body?.usage ?? {};
    const units = Number.isInteger(usage.total_tokens) ? usage.total_tokens : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    return {
      text: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      units: Number.isInteger(units) && units > 0 ? units : 0,
      model: typeof body?.model === 'string' ? body.model : '',
      refused: choice?.finish_reason === 'content_filter' || Boolean(choice?.message?.refusal),
    };
  },
};
