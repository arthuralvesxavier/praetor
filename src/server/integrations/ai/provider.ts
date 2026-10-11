import type { AnalysisOutput } from "@/domain/analysis";
import type { AiMode, AnalysisType } from "@/domain/enums";

/**
 * Provider-neutral AI interface. Implementations: Anthropic (live) and Demo
 * (deterministic rules, no AI). Source texts are UNTRUSTED data: providers only
 * ever embed them inside delimited <source> blocks built by ./prompt.ts.
 */
export type AiSource = {
  /** Stable reference cited by findings, e.g. "S1". */
  ref: string;
  /** `legal_process`, `occurrence`, `contract`, `document_version`... */
  kind: string;
  label: string;
  text: string;
};

export type AiAnalysisRequest = {
  type: AnalysisType;
  subjectLabel: string;
  question: string | null;
  sources: AiSource[];
};

export type AiUsage = { inputTokens: number; outputTokens: number };

export type AiAnalysisResponse = { output: AnalysisOutput; usage: AiUsage };

export interface AiProvider {
  name: string;
  model: string;
  mode: AiMode;
  analyze(req: AiAnalysisRequest): Promise<AiAnalysisResponse>;
}

/**
 * Error raised by providers. `message` is a sanitized technical description
 * (never contains prompts, document text or raw provider payloads);
 * `userMessage` is the pt-BR text that may be stored and shown to users.
 */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  readonly userMessage: string;

  constructor(message: string, opts: { retryable: boolean; userMessage: string }) {
    super(message);
    this.name = "AiProviderError";
    this.retryable = opts.retryable;
    this.userMessage = opts.userMessage;
  }
}
