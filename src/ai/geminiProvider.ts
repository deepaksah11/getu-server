import { AICompletionOptions, AICompletionResult, AIProvider } from './provider.js';
import { logger } from '../config/logger.js';

// Tried in order after the configured model when it is unavailable (404 / 429 / 503).
// The "-latest" aliases follow Google's current stable models.
const FALLBACK_MODELS = [
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash-lite',
];

const REQUEST_TIMEOUT_MS = 60000;

export class GeminiProvider implements AIProvider {
  public name = 'gemini';
  private apiKey: string;
  private defaultModel: string;
  // Remember models that returned 404 so every request does not probe them again
  private unavailableModels = new Set<string>();
  // Rate-limited / overloaded models are skipped until this time (ms epoch)
  private cooldownUntil = new Map<string, number>();

  constructor(apiKey: string, defaultModel: string = 'gemini-2.5-flash') {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  async generateText(prompt: string, options?: AICompletionOptions): Promise<AICompletionResult> {
    const preferredModel = options?.model || this.defaultModel;
    const now = Date.now();
    const modelsToTry = [preferredModel, ...FALLBACK_MODELS.filter((m) => m !== preferredModel)].filter(
      (m) => !this.unavailableModels.has(m) && (this.cooldownUntil.get(m) || 0) <= now
    );
    if (modelsToTry.length === 0) {
      // Every model is cooling down after rate limits: fail fast so callers use the offline engine
      throw new Error('Gemini is rate-limited right now (all models cooling down)');
    }

    let lastError: Error | null = null;

    for (const model of modelsToTry) {
      // The key travels in a header, not the URL, so it never appears in logs or proxies
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const startTime = Date.now();

      const requestBody: any = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: options?.temperature ?? 0.2,
          maxOutputTokens: options?.maxOutputTokens ?? 8192,
          responseMimeType: options?.responseMimeType ?? 'application/json',
        },
      };

      if (options?.systemInstruction) {
        requestBody.systemInstruction = { parts: [{ text: options.systemInstruction }] };
      }

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        const latencyMs = Date.now() - startTime;

        if (!response.ok) {
          const errorText = (await response.text()).slice(0, 300);
          if (response.status === 404) {
            this.unavailableModels.add(model);
          } else if (response.status === 429 || response.status === 503) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '', 10);
            this.cooldownUntil.set(model, Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : 60000));
          }
          if (response.status === 429 || response.status === 404 || response.status === 503 || response.status === 500) {
            logger.warn({ model, status: response.status }, 'Gemini model unavailable; trying the next model');
            lastError = new Error(`Gemini API error (${response.status}) on ${model}: ${errorText}`);
            continue;
          }
          // 400 / 401 / 403: bad request or key problem; other models will fail the same way
          throw new Error(`Gemini API error (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as any;
        const candidate = data.candidates?.[0];
        const text = (candidate?.content?.parts || []).map((p: any) => p.text || '').join('');
        if (!text) {
          lastError = new Error(`Gemini returned an empty response (finishReason: ${candidate?.finishReason || 'unknown'})`);
          continue;
        }

        return {
          text,
          inputTokens: data.usageMetadata?.promptTokenCount || Math.ceil(prompt.length / 4),
          outputTokens: data.usageMetadata?.candidatesTokenCount || Math.ceil(text.length / 4),
          latencyMs,
          model,
        };
      } catch (err: any) {
        if (String(err.message).startsWith('Gemini API error (4')) throw err;
        lastError = err;
        logger.warn({ model, err: err.message?.slice(0, 200) }, 'Gemini request failed, trying next model');
      }
    }

    throw lastError || new Error('All candidate Gemini models failed to generate completion');
  }
}
