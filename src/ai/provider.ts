export interface AICompletionOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
  responseMimeType?: string;
}

export interface AICompletionResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
}

export interface AIProvider {
  name: string;
  generateText(prompt: string, options?: AICompletionOptions): Promise<AICompletionResult>;
}
