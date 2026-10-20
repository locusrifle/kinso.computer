// Fast is OpenAI priority service, not a different reasoning budget. Keep this
// at Pi's public stream boundary: compaction/branch summaries use it too, while
// agent.onPayload alone only covers ordinary turns. No provider implementation
// or persisted model metadata is replaced.
function supportsGPTPriority(model) {
  if (!/^gpt-/i.test(model?.id ?? '')) return false;
  if (!((model.provider === 'openai' && model.api === 'openai-responses') ||
        (model.provider === 'openai-codex' && model.api === 'openai-codex-responses'))) return false;
  try {
    const url = new URL(model.baseUrl);
    // A compatible proxy under the same provider name is not OpenAI itself.
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'chatgpt.com' || (model.provider === 'openai' && url.hostname === 'api.openai.com'));
  } catch { return false; }
}

export function gptFastPayload(payload, model, serviceTier) {
  if (!supportsGPTPriority(model) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  // Explicit payload choices (including default/auto/flex) win. The typed
  // serviceTier option is also respected: Pi streamSimple currently drops it
  // when converting to API options, unlike stream().
  if (Object.hasOwn(payload, 'service_tier')) return payload;
  return { ...payload, service_tier: serviceTier ?? 'priority' };
}

export function withGPTFastMode(streamFn) {
  return (model, context, options) => {
    if (!supportsGPTPriority(model)) return streamFn(model, context, options);
    return streamFn(model, context, {
      ...options,
      onPayload: async (payload, requestModel) => {
        // Compose with Pi's existing extension hook before filling the default.
        const replacement = await options?.onPayload?.(payload, requestModel);
        return gptFastPayload(replacement === undefined ? payload : replacement, requestModel, options?.serviceTier);
      },
    });
  };
}
