import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { analysisOutputSchema, type AnalysisOutput } from "@/domain/analysis";
import { env } from "@/server/env";
import { buildSystemPrompt, buildUserContent } from "./prompt";
import { AiProviderError, type AiAnalysisRequest, type AiAnalysisResponse, type AiProvider } from "./provider";

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Live provider backed by the official Anthropic SDK (structured outputs via
 * `client.beta.messages.parse` + zod). Adaptive thinking is the model default
 * (no `thinking`, `temperature` or `budget_tokens` are sent). Server-side
 * refusal fallbacks are enabled with the `"default"` routing.
 *
 * Errors are mapped to AiProviderError with a sanitized pt-BR message; raw
 * provider payloads are never propagated.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly mode = "live" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxOutputTokens: number;
  private readonly effort: "low" | "medium" | "high" | "xhigh" | "max";

  constructor(opts?: { apiKey?: string; model?: string }) {
    const e = env();
    const apiKey = opts?.apiKey ?? e.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AiProviderError("anthropic_api_key_missing", {
        retryable: false,
        userMessage: "A integração com o provedor de IA não está configurada (chave de API ausente).",
      });
    }
    this.model = opts?.model ?? e.AI_MODEL;
    this.maxOutputTokens = e.AI_MAX_OUTPUT_TOKENS;
    this.effort = e.AI_EFFORT;
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
  }

  async analyze(req: AiAnalysisRequest): Promise<AiAnalysisResponse> {
    const format = betaZodOutputFormat(analysisOutputSchema);
    const system = buildSystemPrompt();
    const userContent = buildUserContent(req);
    const usage = { inputTokens: 0, outputTokens: 0 };

    // One extra attempt when the structured output cannot be parsed.
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response;
      try {
        response = await this.client.beta.messages.parse({
          model: this.model,
          max_tokens: this.maxOutputTokens,
          system,
          messages: [{ role: "user", content: userContent }],
          output_config: { effort: this.effort, format },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        });
      } catch (err) {
        const mapped = mapSdkError(err);
        if (mapped === "parse_failure") {
          if (attempt < 2) continue;
          throw new AiProviderError("structured_output_parse_failed", {
            retryable: false,
            userMessage:
              "A resposta do provedor de IA não pôde ser interpretada. Tente novamente com menos documentos ou uma pergunta mais específica.",
          });
        }
        throw mapped;
      }

      usage.inputTokens += response.usage?.input_tokens ?? 0;
      usage.outputTokens += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === "refusal") {
        throw new AiProviderError("provider_refusal", {
          retryable: false,
          userMessage: "O provedor de IA recusou a solicitação.",
        });
      }
      if (response.stop_reason === "max_tokens") {
        throw new AiProviderError("max_tokens_reached", {
          retryable: false,
          userMessage:
            "A resposta da IA excedeu o tamanho máximo permitido. Solicite a análise com menos fontes ou um escopo menor.",
        });
      }

      const parsed: AnalysisOutput | null = response.parsed_output ?? null;
      if (parsed) {
        // Re-validate with our own schema (the service validates again before storing).
        const check = analysisOutputSchema.safeParse(parsed);
        if (check.success) return { output: check.data, usage };
      }
      if (attempt >= 2) {
        throw new AiProviderError("structured_output_missing", {
          retryable: true,
          userMessage: "O provedor de IA não retornou um resultado válido. A análise será tentada novamente.",
        });
      }
    }
    // Unreachable, kept for the type checker.
    throw new AiProviderError("unexpected_state", { retryable: true, userMessage: "Falha inesperada na análise de IA." });
  }
}

/** Maps SDK errors (most specific first) to AiProviderError; returns "parse_failure" for local parse errors. */
function mapSdkError(err: unknown): AiProviderError | "parse_failure" {
  if (err instanceof AiProviderError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError(`provider_auth_error_${err.status}`, {
      retryable: false,
      userMessage: "O provedor de IA recusou as credenciais configuradas. Verifique a configuração da integração.",
    });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new AiProviderError("provider_not_found", {
      retryable: false,
      userMessage: "O modelo de IA configurado não está disponível. Verifique a configuração da integração.",
    });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
    return new AiProviderError(`provider_bad_request_${err.status}`, {
      retryable: false,
      userMessage: "O provedor de IA rejeitou a solicitação (conteúdo muito extenso ou parâmetros inválidos).",
    });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AiProviderError("provider_rate_limited", {
      retryable: true,
      userMessage: "O provedor de IA está com limite de requisições excedido. A análise será tentada novamente.",
    });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new AiProviderError(`provider_server_error_${err.status}`, {
      retryable: true,
      userMessage: "O provedor de IA está temporariamente indisponível. A análise será tentada novamente.",
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    // Includes APIConnectionTimeoutError.
    return new AiProviderError("provider_connection_error", {
      retryable: true,
      userMessage: "Não foi possível conectar ao provedor de IA. A análise será tentada novamente.",
    });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    return new AiProviderError(`provider_api_error_${status}`, {
      retryable: status >= 500 || status === 408 || status === 409,
      userMessage: "O provedor de IA retornou um erro. Tente novamente mais tarde.",
    });
  }
  if (err instanceof Anthropic.AnthropicError) {
    // Non-HTTP SDK error: the structured output could not be parsed/validated locally.
    return "parse_failure";
  }
  return new AiProviderError("provider_unknown_error", {
    retryable: true,
    userMessage: "Falha inesperada ao chamar o provedor de IA.",
  });
}
