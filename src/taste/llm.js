// Taste Gap: LLM provider adapters and the fallback chain for the agent loop.
//
// The agent keeps one provider-neutral transcript and each adapter renders it
// for its own API on every turn, so a run that falls back mid-way (Gemini to
// Groq, say) carries the whole conversation across. Transcript entries:
//
//   { role: 'user', text }
//   { role: 'assistant', source, text, calls: [{ id, name, input, extra }], native }
//   { role: 'tool', results: [{ id, name, content, isError }] }
//
// `source` is the chain entry that wrote the turn ("gemini:gemini-3.6-flash").
// `native` is that model's own assistant message (Claude's content blocks,
// thinking included) and `extra` is per-call model data (Gemini 3's thought
// signature). Both are only sent back to the exact model that produced them.
//
// ── Providers (all checked 2026-10-29) ────────────────────────────────────────
//   gemini      Google's OpenAI-compatible endpoint (/v1beta/openai).
//               gemini-3.6-flash answered a parallel tool call in about 4s;
//               gemini-3.8-flash and gemini-flash-latest took over two minutes.
//               The free tier allows 20 requests a day PER MODEL, so a second
//               model (gemini-3.5-flash) is its own quota. GEMINI_MODEL and
//               GEMINI_SECOND_MODEL override them.
//   groq        Groq's OpenAI-compatible endpoint. qwen/qwen3.8-27b is the model
//               on this key that makes parallel tool calls. Free keys are
//               capped at 8K tokens a minute, 7K input per request and 1K
//               output a minute. GROQ_MODEL overrides it.
//   openrouter  OpenRouter, free (":free") models only. No DeepSeek, Qwen or GLM
//               model was free with tool support, so the defaults are the free
//               tool-capable models that passed one real Taste Gap run each
//               (eight parallel tool calls and a valid submit_brief):
//               nemotron-3.5-super-vl in 22s, nemotron-3-ultra in 114s.
//               google/gemma-4-31b-it:free was dropped (upstream 429 on its
//               run). OPENROUTER_MODELS (comma separated) overrides them. Free
//               models allow 20 requests a minute and 50 a day (1000 a day
//               after buying 10 credits).
//   baseten     Baseten Model APIs (inference.baseten.co/v1), paid per token.
//               Off: it has no default models, so it only runs with
//               BASETEN_API_KEY set, models in BASETEN_MODELS (comma
//               separated) and "baseten" in LLM_CHAIN. Not yet tried on a
//               real run: the only key tried (2026-10-30) could list models
//               but got 403 "please check the api-key you provided" on every
//               chat request.
//   zai         Z.ai international endpoint (api.z.ai/api/paas/v4).
//               glm-4.7-flash is the free GLM Flash model (GLM-5.3-Flash is
//               paid). Its trial run timed out and then got 429 "temporarily
//               overloaded", so it is not in the default chain; add "zai" to
//               LLM_CHAIN to use it. ZAI_MODEL overrides the model.
//   anthropic   The Messages API through the Anthropic SDK. Not in the default
//               chain; add it through LLM_CHAIN.
//   scripted    No model at all: src/taste/scripted.js plays the model's part
//               from a fixed script over the real Qloo tools, for building and
//               demoing without model quota. Needs no key. Opt in with
//               LLM_CHAIN=scripted; it is never in the default chain.
//
// ── Chain ─────────────────────────────────────────────────────────────────────
// LLM_CHAIN is a comma-separated list of entries tried in order. An entry is a
// provider name ("groq", meaning its configured model) or provider:model
// ("gemini:gemini-3.5-flash"); "openrouter" alone expands to every model in
// OPENROUTER_MODELS. Example: LLM_CHAIN=gemini,groq,openrouter,zai.
// Unset, the chain is DEFAULT_CHAIN below, with
// LLM_PROVIDER (if set) moved to the front. Entries whose API key is blank are
// skipped.
//
// onlyProvider() narrows a chain to one provider's entries, for a caller
// pinned to it (generate-featured.js --provider).
//
// Privacy: adapters send only what the agent hands them (the system prompt,
// the brand, rival and city names, and Qloo tool results). No request carries
// a user id, email or the OpenAI `user` field. Free endpoints may keep
// prompts, which is one more reason account data never enters a prompt.
//
// Errors come back as plain Errors carrying status, code and headers, never
// the raw axios error, whose config holds the Authorization header.

const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { scriptedProvider } = require('./scripted');

const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    kind: 'openai',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    baseEnv: 'GEMINI_BASE_URL',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.6-flash',
    maxTokens: 16000,
    timeoutMs: 45000,
    // Gemini 3 cannot turn thinking off; low keeps each turn quick.
    extra: () => ({ reasoning_effort: 'low' }),
  },
  groq: {
    label: 'Groq',
    kind: 'openai',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    baseEnv: 'GROQ_BASE_URL',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'qwen/qwen3.8-27b',
    // Free-tier Groq allows 1,000 output tokens a minute and refuses a request
    // whose expected output passes that, so stay under it. GROQ_MAX_TOKENS
    // overrides it on a paid tier.
    maxTokensEnv: 'GROQ_MAX_TOKENS',
    maxTokens: 950,
    timeoutMs: 30000,
    // Free-tier Groq answers 413 to any request over 7,000 input tokens. The
    // agent trims older tool results to stay under this estimate, which
    // leaves room for the estimate being off. GROQ_INPUT_BUDGET overrides it
    // (raise it on a paid tier, or set 0 for no limit).
    inputBudgetEnv: 'GROQ_INPUT_BUDGET',
    inputBudget: 5500,
    // Reasoning tokens count against the per-minute budget, so keep them off
    // (qwen) or low (gpt-oss).
    extra: model => (/^openai\/gpt-oss/.test(model) ? { reasoning_effort: 'low' }
      : /^qwen\//.test(model) ? { reasoning_effort: 'none' } : {}),
  },
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    keyEnv: 'OPENROUTER_API_KEY',
    modelsEnv: 'OPENROUTER_MODELS',
    baseEnv: 'OPENROUTER_BASE_URL',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Faster first: both passed, super-vl in 22s, ultra in 114s.
    models: [
      'nvidia/nemotron-3.5-super-vl:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
    ],
    maxTokens: 8000,
    timeoutMs: 60000,
    // Route only to upstream providers that support every parameter sent
    // (tools and tool_choice), so a free model is never served by a host that
    // silently drops tools.
    extra: () => ({ provider: { require_parameters: true } }),
    headers: () => ({ 'X-Title': 'Nivaria' }),
  },
  baseten: {
    label: 'Baseten',
    kind: 'openai',
    keyEnv: 'BASETEN_API_KEY',
    modelsEnv: 'BASETEN_MODELS',
    baseEnv: 'BASETEN_BASE_URL',
    baseUrl: 'https://inference.baseten.co/v1',
    // None by default, so the provider stays off until BASETEN_MODELS names some.
    models: [],
    maxTokens: 8000,
    timeoutMs: 60000,
  },
  zai: {
    label: 'Z.ai',
    kind: 'openai',
    keyEnv: 'ZAI_API_KEY',
    modelEnv: 'ZAI_MODEL',
    baseEnv: 'ZAI_BASE_URL',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-4.7-flash',
    maxTokens: 8000,
    timeoutMs: 60000,
    // Thinking makes the free Flash model much slower; the brief does not need it.
    extra: () => ({ thinking: { type: 'disabled' } }),
    // Z.ai documents tool_choice "auto" only, so the final turn narrows the
    // tool list to submit_brief instead of forcing it.
    forceToolChoice: false,
  },
  anthropic: {
    label: 'Claude',
    kind: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-4-6', // matches src/analyzer.js
    maxTokens: 16000,
    timeoutMs: 90000,
  },
  scripted: {
    label: 'Scripted stand-in',
    kind: 'scripted',
    model: 'script',
    timeoutMs: 10000,
  },
};

const SECOND_GEMINI_MODEL = 'gemini-3.5-flash';

// gemini primary, a second Gemini model (its own daily quota), groq, then
// every OpenRouter model. Z.ai failed its trial run, so it is opt-in.
const DEFAULT_CHAIN = () => [
  'gemini',
  'gemini:' + (process.env.GEMINI_SECOND_MODEL || SECOND_GEMINI_MODEL),
  'groq',
  'openrouter',
];

// A provider without a keyEnv (the scripted stand-in) needs no key.
const isConfigured = name => Boolean(PROVIDERS[name]
  && (!PROVIDERS[name].keyEnv || String(process.env[PROVIDERS[name].keyEnv] || '').trim()));

const splitList = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

function defaultModels(name) {
  const cfg = PROVIDERS[name];
  if (cfg.modelsEnv) {
    const listed = splitList(process.env[cfg.modelsEnv]);
    return listed.length ? listed : cfg.models;
  }
  return [process.env[cfg.modelEnv] || cfg.model];
}

const providerOf = token => token.split(':')[0].trim().toLowerCase();

// A chain's entries as written: spec in LLM_CHAIN syntax, else LLM_CHAIN,
// else DEFAULT_CHAIN with LLM_PROVIDER moved to the front.
function chainTokens(spec) {
  let tokens = splitList(spec == null ? process.env.LLM_CHAIN : spec);
  if (!tokens.length) {
    tokens = DEFAULT_CHAIN();
    const first = String(process.env.LLM_PROVIDER || '').trim().toLowerCase();
    if (first) {
      if (!PROVIDERS[first]) throw new Error('LLM_PROVIDER must be one of ' + Object.keys(PROVIDERS).join(', ') + ', got "' + first + '"');
      const mine = tokens.filter(t => providerOf(t) === first);
      tokens = [...(mine.length ? mine : [first]), ...tokens.filter(t => providerOf(t) !== first)];
    }
  }
  return tokens;
}

// One provider's entries of a chain (both Gemini models, say), in LLM_CHAIN
// syntax; the provider's configured models when the chain has none of it.
function onlyProvider(name, spec) {
  const p = String(name || '').trim().toLowerCase();
  if (!PROVIDERS[p]) throw new Error('Unknown provider "' + name + '": use one of ' + Object.keys(PROVIDERS).join(', '));
  const mine = chainTokens(spec).filter(t => providerOf(t) === p);
  return (mine.length ? mine : [p]).join(',');
}

// The ordered list of { name, model, key } entries a run may use.
// spec: a chain in LLM_CHAIN syntax for one caller; unset, LLM_CHAIN and then
// DEFAULT_CHAIN apply.
function buildChain(spec) {
  const tokens = chainTokens(spec);
  const chain = [];
  for (const token of tokens) {
    // Model ids can contain ":" (OpenRouter's ":free"), so split on the first one.
    const cut = token.indexOf(':');
    const name = (cut === -1 ? token : token.slice(0, cut)).toLowerCase();
    const model = cut === -1 ? null : token.slice(cut + 1);
    if (!PROVIDERS[name]) throw new Error('Unknown provider "' + name + '" in LLM_CHAIN');
    if (!isConfigured(name)) continue;
    for (const m of model ? [model] : defaultModels(name)) {
      const key = name + ':' + m;
      if (!chain.some(e => e.key === key)) chain.push({ name, model: m, key });
    }
  }
  if (!chain.length) {
    throw new Error('No LLM provider is configured: set at least one of '
      + Object.values(PROVIDERS).map(p => p.keyEnv).filter(Boolean).join(', ') + ', or use LLM_CHAIN=scripted');
  }
  return chain;
}

function providerError(message, { status = null, code = null, headers = null, timeout = false, network = false, retryAfterMs = null } = {}) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (headers) e.headers = headers;
  e.timeout = timeout;
  e.network = network;
  e.retryAfterMs = retryAfterMs;
  return e;
}

// What a failed model call means for the chain:
//   { action: 'retry', why }  transient (429, 5xx, timeout, connection, a
//                             malformed tool call): back off, try once more,
//                             then move to the next entry.
//   { action: 'skip', why }   this entry cannot work (bad key, unknown model,
//                             no credit): move to the next entry at once.
//   null                      fatal for the run (a malformed request, or the
//                             run's own deadline).
// Groq's tool_use_failed is a 400, but it means the model emitted a broken
// tool call, which a second sample usually fixes, so it is retried.
function classifyFailure(err) {
  if (!err || err.aborted) return null;
  const s = err.status;
  if (s === 401 || s === 403) return { action: 'skip', why: 'auth error (' + s + ')' };
  if (s === 402) return { action: 'skip', why: 'no credit (402)' };
  if (s === 404) return { action: 'skip', why: 'model not available (404)' };
  if (s === 429) return { action: 'retry', why: 'rate limit (429)' };
  if (s >= 500) return { action: 'retry', why: 'server error (' + s + ')' };
  if (err.timeout) return { action: 'retry', why: 'timeout' };
  if (err.network) return { action: 'retry', why: 'connection error' };
  if (s === 400 && err.code === 'tool_use_failed') return { action: 'retry', why: 'malformed tool call' };
  return null;
}

// Rough input size of one request, in tokens. chars / 3 runs high for this
// JSON-heavy transcript, which is the safe direction for a hard limit.
function estimateTokens(system, transcript, tools) {
  let chars = system.length + JSON.stringify(tools).length;
  for (const t of transcript) {
    if (t.role === 'tool') chars += t.results.reduce((s, r) => s + r.content.length + 40, 0);
    else chars += (t.text || '').length + JSON.stringify(t.calls || []).length;
  }
  return Math.ceil(chars / 3);
}

// ── OpenAI-compatible chat completions (Gemini, Groq, OpenRouter, Z.ai) ───────

const toFunctionTool = t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
});

// Qwen-style models can leak <think> blocks into content.
const stripThinking = s => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();

function renderOpenAI(entry, system, transcript) {
  const messages = [{ role: 'system', content: system }];
  for (const t of transcript) {
    if (t.role === 'user') {
      messages.push({ role: 'user', content: t.text });
    } else if (t.role === 'assistant') {
      const msg = { role: 'assistant', content: t.text || '' };
      if (t.calls.length) {
        msg.tool_calls = t.calls.map((c, i) => {
          const call = { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } };
          if (t.source === entry.key && c.extra) {
            call.extra_content = c.extra;
          } else if (entry.name === 'gemini' && i === 0) {
            // Gemini 3 wants a thought signature on the first call of each
            // model turn and answers 400 "Function call is missing a
            // thought_signature" for turns another model wrote. This
            // placeholder is accepted instead (tested 2026-10-29).
            call.extra_content = { google: { thought_signature: 'skip_thought_signature_validator' } };
          }
          return call;
        });
      }
      messages.push(msg);
    } else if (t.role === 'tool') {
      for (const r of t.results) {
        messages.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.isError ? 'Error: ' + r.content : r.content });
      }
    }
  }
  return messages;
}

function parseOpenAI(data) {
  const choice = data?.choices?.[0] || {};
  const msg = choice.message || {};
  const calls = (msg.tool_calls || []).map(c => {
    let input = {};
    let inputError = null;
    try {
      input = c.function?.arguments ? JSON.parse(c.function.arguments) : {};
    } catch (_) {
      inputError = 'The arguments were not valid JSON. Call the tool again with a JSON object.';
    }
    return { id: c.id || null, name: c.function?.name, input, inputError, extra: c.extra_content || null };
  });
  const finish = choice.finish_reason;
  const u = data?.usage || {};
  return {
    text: stripThinking(msg.content),
    calls,
    stopReason: finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : calls.length ? 'tool_use' : 'end',
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: u.prompt_tokens_details?.cached_tokens || 0,
    },
    native: null,
  };
}

// Gemini puts its wait in the body ("retryDelay": "1644s"), not in a header.
function bodyRetryMs(data) {
  const details = (Array.isArray(data) ? data[0]?.error : data?.error)?.details || [];
  for (const d of details) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay || ''));
    if (m) return Math.round(Number(m[1]) * 1000);
  }
  return null;
}

function openAIProvider(entry, cfg) {
  const { model } = entry;
  const baseUrl = (process.env[cfg.baseEnv] || cfg.baseUrl).replace(/\/+$/, '');
  const envBudget = cfg.inputBudgetEnv ? process.env[cfg.inputBudgetEnv] : undefined;
  const inputBudget = envBudget != null && envBudget !== '' ? Number(envBudget) || 0 : cfg.inputBudget || 0;
  const maxTokens = (cfg.maxTokensEnv && Number(process.env[cfg.maxTokensEnv])) || cfg.maxTokens;
  return {
    ...entry, label: cfg.label + ' (' + model + ')', timeoutMs: cfg.timeoutMs, inputBudget,
    async complete({ system, transcript, tools, finalOnly, signal, timeoutMs }) {
      const body = {
        model,
        messages: renderOpenAI(entry, system, transcript),
        tools: tools.map(toFunctionTool),
        tool_choice: finalOnly && cfg.forceToolChoice !== false ? 'required' : 'auto',
        max_tokens: maxTokens,
        ...(cfg.extra ? cfg.extra(model) : {}),
      };
      let resp;
      try {
        resp = await axios.post(baseUrl + '/chat/completions', body, {
          headers: {
            Authorization: 'Bearer ' + process.env[cfg.keyEnv],
            'Content-Type': 'application/json',
            ...(cfg.headers ? cfg.headers() : {}),
          },
          timeout: timeoutMs,
          signal,
        });
      } catch (err) {
        if (axios.isCancel(err)) throw Object.assign(providerError(cfg.label + ' request cancelled'), { aborted: true });
        const status = err.response?.status || null;
        const data = err.response?.data;
        const apiErr = Array.isArray(data) ? data[0]?.error : data?.error;
        const detail = apiErr?.message || (typeof data === 'string' ? data.slice(0, 200) : null) || err.message;
        throw providerError(cfg.label + ' request failed' + (status ? ' (' + status + ')' : '') + ': ' + detail, {
          status,
          code: apiErr?.code || err.code || null,
          headers: err.response?.headers || null,
          timeout: err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT',
          network: !status && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(err.code),
          retryAfterMs: bodyRetryMs(data),
        });
      }
      // OpenRouter can answer 200 with an error object when the upstream fails.
      if (resp.data?.error && !resp.data?.choices) {
        const e = resp.data.error;
        const status = Number(e.code) || 502;
        throw providerError(cfg.label + ' upstream error (' + status + '): ' + (e.message || 'unknown'), { status });
      }
      return parseOpenAI(resp.data);
    },
  };
}

// ── Anthropic Messages API ────────────────────────────────────────────────────

let anthropicClient;
function getAnthropic() {
  if (!anthropicClient) {
    // maxRetries: 0 because the agent owns retry and fallback.
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  }
  return anthropicClient;
}

function renderAnthropic(entry, transcript) {
  const messages = [];
  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    // Tool results and a following nudge are both user content: one message.
    if (last && last.role === role && role === 'user') last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const t of transcript) {
    if (t.role === 'user') {
      push('user', [{ type: 'text', text: t.text }]);
    } else if (t.role === 'assistant') {
      if (t.source === entry.key && t.native) {
        push('assistant', t.native.map(b => ({ ...b })));
      } else {
        const blocks = [];
        if (t.text) blocks.push({ type: 'text', text: t.text });
        for (const c of t.calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} });
        push('assistant', blocks.length ? blocks : [{ type: 'text', text: '(no reply)' }]);
      }
    } else if (t.role === 'tool') {
      push('user', t.results.map(r => ({
        type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}),
      })));
    }
  }
  // One moving cache breakpoint on the newest block; the system prompt holds
  // the other. Blocks are copies, so the transcript itself stays clean.
  const last = messages[messages.length - 1];
  last.content[last.content.length - 1] = { ...last.content[last.content.length - 1], cache_control: { type: 'ephemeral' } };
  return messages;
}

function anthropicProvider(entry, cfg) {
  return {
    ...entry, label: cfg.label + ' (' + entry.model + ')', timeoutMs: cfg.timeoutMs, inputBudget: 0,
    async complete({ system, transcript, tools, finalOnly, signal, timeoutMs }) {
      // Adaptive thinking needs every earlier assistant turn to carry this
      // model's own thinking blocks, so it is off once another model wrote a
      // turn. Without thinking the final turn can force submit_brief outright.
      const ownHistory = transcript.every(t => t.role !== 'assistant' || t.source === entry.key);
      const params = {
        model: entry.model,
        max_tokens: cfg.maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages: renderAnthropic(entry, transcript),
      };
      if (ownHistory) {
        params.thinking = { type: 'adaptive' };
        params.output_config = { effort: 'medium' };
      } else if (finalOnly) {
        params.tool_choice = { type: 'tool', name: tools[0].name };
      }
      let response;
      try {
        response = await getAnthropic().messages.create(params, { signal, timeout: timeoutMs });
      } catch (err) {
        if (err instanceof Anthropic.APIUserAbortError) throw Object.assign(providerError('Claude request cancelled'), { aborted: true });
        throw providerError('Claude request failed' + (err.status ? ' (' + err.status + ')' : '') + ': ' + (err.error?.error?.message || err.message), {
          status: err.status || null,
          code: err.error?.error?.type || null,
          headers: err.headers || null,
          timeout: err instanceof Anthropic.APIConnectionTimeoutError,
          network: err instanceof Anthropic.APIConnectionError && !(err instanceof Anthropic.APIConnectionTimeoutError),
        });
      }
      const calls = response.content.filter(b => b.type === 'tool_use')
        .map(b => ({ id: b.id, name: b.name, input: b.input, inputError: null, extra: null }));
      return {
        text: response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
        calls,
        stopReason: response.stop_reason === 'refusal' ? 'refusal'
          : response.stop_reason === 'max_tokens' ? 'max_tokens' : calls.length ? 'tool_use' : 'end',
        usage: {
          input_tokens: response.usage?.input_tokens || 0,
          output_tokens: response.usage?.output_tokens || 0,
          cache_creation_input_tokens: response.usage?.cache_creation_input_tokens || 0,
          cache_read_input_tokens: response.usage?.cache_read_input_tokens || 0,
        },
        native: response.content,
      };
    },
  };
}

function createProvider(entry) {
  const cfg = PROVIDERS[entry.name];
  if (!cfg) throw new Error('Unknown LLM provider ' + entry.name);
  if (cfg.kind === 'scripted') return scriptedProvider(entry, cfg);
  return cfg.kind === 'anthropic' ? anthropicProvider(entry, cfg) : openAIProvider(entry, cfg);
}

module.exports = { PROVIDERS, SECOND_GEMINI_MODEL, buildChain, chainTokens, onlyProvider, createProvider, classifyFailure, isConfigured, estimateTokens };
