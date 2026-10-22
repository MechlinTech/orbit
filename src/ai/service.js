/**
 * Multi-AI Completion Service for Orbit ATS
 * Manages provider execution, bounded retries on transient errors,
 * strict timeout enforcement, and normalized responses.
 */

import { resolveAiProvider } from './provider.js';

export class AiProviderError extends Error {
  constructor(message, { code = 'AI_ERROR', status = null, provider = 'unknown', model = '', cause = null, isRetryable = false } = {}) {
    // Sanitize any potential secrets from the message
    const sanitizedMsg = message
      .replace(/Bearer\s+[a-zA-Z0-9_\-.]+/gi, 'Bearer [REDACTED]')
      .replace(/x-api-key:\s*[^\s]+/gi, 'x-api-key: [REDACTED]')
      .replace(/key=[a-zA-Z0-9_\-]+/gi, 'key=[REDACTED]');
    super(sanitizedMsg);
    this.name = 'AiProviderError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.cause = cause;
    this.isRetryable = isRetryable;
  }
}

/**
 * Extracts and parses JSON from raw text, stripping markdown code block fences if present.
 */
export function extractJsonFromText(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('AI provider returned empty content.');
  }
  let text = rawText.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  return JSON.parse(text);
}

/**
 * Helper to execute an async operation with bounded retries on transient errors.
 */
export async function withAiRetries(fn, { maxRetries = 2, initialDelayMs = 60 } = {}) {
  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isRetryable = err?.isRetryable ||
        err?.status === 429 ||
        err?.status === 502 ||
        err?.status === 503 ||
        err?.status === 504 ||
        err?.code === 'RATE_LIMITED' ||
        err?.code === 'PROVIDER_UNAVAILABLE';

      if (attempt > maxRetries || !isRetryable) {
        throw err;
      }

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 1000);
    }
  }
}

/**
 * Executes an AI completion through the resolved or specified provider.
 * Normalizes request and response format across all providers.
 */
export async function executeAiCompletion({
  prompt,
  systemPrompt,
  jsonSchema = false,
  provider,
  model,
  config,
  transport = globalThis.fetch,
  timeoutMs = 8000,
  maxRetries = 2,
  temperature = 0.1
} = {}) {
  const providerInstance = resolveAiProvider({ provider, model, config });

  if (!providerInstance) {
    throw new AiProviderError('No AI provider configured.', {
      code: 'CONFIG_ERROR',
      provider: provider || 'unconfigured'
    });
  }

  const endpoint = providerInstance.getEndpoint();
  const headers = providerInstance.getHeaders();
  const body = providerInstance.buildRequestBody({
    prompt,
    systemPrompt,
    jsonSchema,
    temperature
  });

  const startTime = Date.now();

  const makeCall = async () => {
    let response;
    try {
      response = await transport(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (netErr) {
      const isTimeout = netErr?.name === 'TimeoutError' || netErr?.name === 'AbortError' || netErr?.message?.includes('timeout');
      throw new AiProviderError(
        isTimeout ? `AI request to ${providerInstance.name} timed out after ${timeoutMs}ms.` : `Network failure reaching ${providerInstance.name}: ${netErr.message}`,
        {
          code: isTimeout ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE',
          provider: providerInstance.name,
          model: providerInstance.model,
          cause: netErr,
          isRetryable: isTimeout
        }
      );
    }

    if (!response.ok) {
      const status = response.status;
      let errorDetails = '';
      try {
        const errJson = await response.json();
        errorDetails = errJson?.error?.message || errJson?.message || JSON.stringify(errJson);
      } catch {
        errorDetails = response.statusText || '';
      }

      let code = 'PROVIDER_UNAVAILABLE';
      let isRetryable = false;

      if (status === 401 || status === 403) {
        code = 'AUTH_FAILED';
      } else if (status === 429) {
        code = 'RATE_LIMITED';
        isRetryable = true;
      } else if (status >= 500) {
        code = 'PROVIDER_UNAVAILABLE';
        isRetryable = true;
      } else if (status === 400 || status === 404) {
        code = 'INVALID_REQUEST';
      }

      throw new AiProviderError(
        `${providerInstance.name} API returned HTTP ${status}: ${errorDetails}`,
        {
          code,
          status,
          provider: providerInstance.name,
          model: providerInstance.model,
          isRetryable
        }
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw new AiProviderError(`Invalid JSON response payload from ${providerInstance.name}.`, {
        code: 'INVALID_RESPONSE',
        status: response.status,
        provider: providerInstance.name,
        model: providerInstance.model,
        cause: parseErr
      });
    }

    const rawText = providerInstance.extractText(data);
    if (!rawText || !rawText.trim()) {
      throw new AiProviderError(`Empty completion content returned by ${providerInstance.name}.`, {
        code: 'INVALID_RESPONSE',
        status: response.status,
        provider: providerInstance.name,
        model: providerInstance.model
      });
    }

    let parsed = null;
    if (jsonSchema) {
      try {
        parsed = extractJsonFromText(rawText);
      } catch (jsonErr) {
        throw new AiProviderError(`Failed to parse structured JSON from ${providerInstance.name}: ${jsonErr.message}`, {
          code: 'INVALID_RESPONSE',
          status: response.status,
          provider: providerInstance.name,
          model: providerInstance.model,
          cause: jsonErr
        });
      }
    }

    const usage = providerInstance.extractUsage(data);
    const latencyMs = Date.now() - startTime;

    return {
      parsed,
      rawText,
      provider: providerInstance.name,
      model: providerInstance.model,
      usage,
      latencyMs
    };
  };

  return withAiRetries(makeCall, { maxRetries });
}
