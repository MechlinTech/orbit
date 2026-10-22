/**
 * Multi-AI Provider Abstraction Layer for Orbit ATS
 * Isolates provider-specific wire protocols for OpenAI, Anthropic Claude,
 * Google Gemini, and xAI Grok behind a unified, secure interface.
 */

export const SUPPORTED_AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'grok'];

export class BaseAiProvider {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  getEndpoint() {
    throw new Error('getEndpoint() must be implemented by provider subclass');
  }

  getHeaders() {
    throw new Error('getHeaders() must be implemented by provider subclass');
  }

  buildRequestBody() {
    throw new Error('buildRequestBody() must be implemented by provider subclass');
  }

  extractText() {
    throw new Error('extractText() must be implemented by provider subclass');
  }

  extractUsage() {
    return {};
  }
}

export class OpenAiProvider extends BaseAiProvider {
  constructor(options = {}) {
    super('openai', options);
    const cfg = options.config || {};
    this.apiKey = options.apiKey ||
      cfg.OPENAI_API_KEY ||
      cfg.AI_PROVIDER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.AI_PROVIDER_API_KEY ||
      '';
    this.apiUrl = options.apiUrl ||
      cfg.OPENAI_API_URL ||
      cfg.AI_PROVIDER_URL ||
      process.env.OPENAI_API_URL ||
      process.env.AI_PROVIDER_URL ||
      'https://api.openai.com/v1/chat/completions';
    this.model = options.model ||
      cfg.OPENAI_MODEL ||
      cfg.AI_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.AI_MODEL ||
      'gpt-4o-mini';
  }

  getEndpoint() {
    return this.apiUrl;
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  buildRequestBody({ prompt, systemPrompt, jsonSchema = false, temperature = 0.1 }) {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    return {
      model: this.model,
      messages,
      temperature,
      ...(jsonSchema ? { response_format: { type: 'json_object' } } : {})
    };
  }

  extractText(data) {
    return data?.choices?.[0]?.message?.content || '';
  }

  extractUsage(data) {
    return {
      promptTokens: data?.usage?.prompt_tokens || 0,
      completionTokens: data?.usage?.completion_tokens || 0,
      totalTokens: data?.usage?.total_tokens || 0
    };
  }
}

export class AnthropicProvider extends BaseAiProvider {
  constructor(options = {}) {
    super('anthropic', options);
    const cfg = options.config || {};
    this.apiKey = options.apiKey ||
      cfg.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      '';
    this.apiUrl = options.apiUrl ||
      cfg.ANTHROPIC_API_URL ||
      process.env.ANTHROPIC_API_URL ||
      'https://api.anthropic.com/v1/messages';
    this.model = options.model ||
      cfg.ANTHROPIC_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      'claude-3-5-sonnet-20241022';
    this.anthropicVersion = options.anthropicVersion ||
      cfg.ANTHROPIC_VERSION ||
      process.env.ANTHROPIC_VERSION ||
      '2023-06-01';
  }

  getEndpoint() {
    return this.apiUrl;
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion
    };
  }

  buildRequestBody({ prompt, systemPrompt, maxTokens = 2048, temperature = 0.1 }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
      temperature
    };
    if (systemPrompt) {
      body.system = systemPrompt;
    }
    return body;
  }

  extractText(data) {
    if (Array.isArray(data?.content)) {
      const textBlock = data.content.find(block => block.type === 'text');
      return textBlock?.text || data.content[0]?.text || '';
    }
    return data?.text || '';
  }

  extractUsage(data) {
    return {
      promptTokens: data?.usage?.input_tokens || 0,
      completionTokens: data?.usage?.output_tokens || 0,
      totalTokens: (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0)
    };
  }
}

export class GeminiProvider extends BaseAiProvider {
  constructor(options = {}) {
    super('gemini', options);
    const cfg = options.config || {};
    this.apiKey = options.apiKey ||
      cfg.GEMINI_API_KEY ||
      cfg.GOOGLE_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      '';
    this.model = options.model ||
      cfg.GEMINI_MODEL ||
      process.env.GEMINI_MODEL ||
      'gemini-1.5-flash';
    this.apiUrl = options.apiUrl ||
      cfg.GEMINI_API_URL ||
      process.env.GEMINI_API_URL ||
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
  }

  getEndpoint() {
    // If URL contains {model} placeholder, substitute it
    return this.apiUrl.replace('{model}', this.model);
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.apiKey
    };
  }

  buildRequestBody({ prompt, systemPrompt, jsonSchema = false, temperature = 0.1 }) {
    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature,
        ...(jsonSchema ? { responseMimeType: 'application/json' } : {})
      }
    };
    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }]
      };
    }
    return body;
  }

  extractText(data) {
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  extractUsage(data) {
    return {
      promptTokens: data?.usageMetadata?.promptTokenCount || 0,
      completionTokens: data?.usageMetadata?.candidatesTokenCount || 0,
      totalTokens: data?.usageMetadata?.totalTokenCount || 0
    };
  }
}

export class GrokProvider extends BaseAiProvider {
  constructor(options = {}) {
    super('grok', options);
    const cfg = options.config || {};
    this.apiKey = options.apiKey ||
      cfg.GROK_API_KEY ||
      cfg.XAI_API_KEY ||
      process.env.GROK_API_KEY ||
      process.env.XAI_API_KEY ||
      '';
    this.apiUrl = options.apiUrl ||
      cfg.GROK_API_URL ||
      cfg.XAI_API_URL ||
      process.env.GROK_API_URL ||
      process.env.XAI_API_URL ||
      'https://api.x.ai/v1/chat/completions';
    this.model = options.model ||
      cfg.GROK_MODEL ||
      cfg.XAI_MODEL ||
      process.env.GROK_MODEL ||
      process.env.XAI_MODEL ||
      'grok-2-latest';
  }

  getEndpoint() {
    return this.apiUrl;
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  buildRequestBody({ prompt, systemPrompt, jsonSchema = false, temperature = 0.1 }) {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    return {
      model: this.model,
      messages,
      temperature,
      ...(jsonSchema ? { response_format: { type: 'json_object' } } : {})
    };
  }

  extractText(data) {
    return data?.choices?.[0]?.message?.content || '';
  }

  extractUsage(data) {
    return {
      promptTokens: data?.usage?.prompt_tokens || 0,
      completionTokens: data?.usage?.completion_tokens || 0,
      totalTokens: data?.usage?.total_tokens || 0
    };
  }
}

/**
 * Factory function to instantiate a provider by name.
 */
export function createAiProvider(name, options = {}) {
  const norm = String(name || '').trim().toLowerCase();
  switch (norm) {
    case 'openai':
      return new OpenAiProvider(options);
    case 'anthropic':
    case 'claude':
      return new AnthropicProvider(options);
    case 'gemini':
    case 'google':
      return new GeminiProvider(options);
    case 'grok':
    case 'xai':
      return new GrokProvider(options);
    default:
      throw new Error(`Unsupported AI provider: "${name}". Supported providers are: ${SUPPORTED_AI_PROVIDERS.join(', ')}`);
  }
}

/**
 * Returns a list of configured AI providers based on environment and options.
 */
export function getAvailableAiProviders(config = {}) {
  const providers = [];
  for (const name of SUPPORTED_AI_PROVIDERS) {
    const instance = createAiProvider(name, { config });
    if (instance.isConfigured()) {
      providers.push({
        id: instance.name,
        name: instance.name === 'openai' ? 'OpenAI'
          : instance.name === 'anthropic' ? 'Anthropic Claude'
          : instance.name === 'gemini' ? 'Google Gemini'
          : 'xAI Grok',
        model: instance.model,
        configured: true
      });
    }
  }
  return providers;
}

/**
 * Resolves the active provider to use based on explicit request options,
 * configured default provider, or available configured credentials.
 */
export function resolveAiProvider(options = {}) {
  const cfg = options.config || {};

  // 1. Explicit provider name passed in options
  if (options.provider) {
    const instance = createAiProvider(options.provider, options);
    return instance.isConfigured() ? instance : null;
  }

  // 2. Default provider explicitly set in configuration
  const defaultName = options.defaultProvider ||
    cfg.AI_DEFAULT_PROVIDER ||
    process.env.AI_DEFAULT_PROVIDER;
  if (defaultName) {
    const instance = createAiProvider(defaultName, options);
    if (instance.isConfigured()) return instance;
  }

  // 3. Auto-detect from supported providers in deterministic priority order
  for (const name of SUPPORTED_AI_PROVIDERS) {
    const instance = createAiProvider(name, options);
    if (instance.isConfigured()) {
      return instance;
    }
  }

  return null;
}
