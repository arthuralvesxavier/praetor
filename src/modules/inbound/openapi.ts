/**
 * OpenAPI 3.1 description of the inbound API (served at GET /api/v1/openapi.json,
 * without authentication and without any organization data).
 */
import { DOCUMENT_CATEGORIES, LEGAL_AREAS, PROCESS_INSTANCES, PROCESS_PHASES } from "@/domain/enums";
import { INBOUND_MAX_DOCUMENTS, INBOUND_MAX_PARTIES, INBOUND_POLOS } from "./schemas";
import { INBOUND_REQUESTS_PER_MINUTE } from "./rate-limit";

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", examples: ["validation"] },
        message: { type: "string" },
        fieldErrors: {
          type: "object",
          additionalProperties: { type: "array", items: { type: "string" } },
          description: 'Erros por campo, com o caminho completo (ex.: "partes.0.polo").',
        },
      },
    },
  },
};

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

export function buildOpenApiDocument(opts: { serverUrl: string; maxUploadMb: number }) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Praetor: API de entrada de processos",
      version: "1.0.0",
      description:
        "Recebe processos novos de sistemas externos e consulta a situação dos processos enviados. " +
        "A organização é sempre a da chave de API (nunca a do corpo). Um número CNJ que já existe na carteira nunca gera " +
        "processo duplicado: os documentos são anexados ao existente. Cada processo novo segue o fluxo de entrada: " +
        "distribuição, análise preliminar (simulação) e e-mail ao advogado (simulado). " +
        `Limite: ${INBOUND_REQUESTS_PER_MINUTE} requisições por minuto por chave (429 com Retry-After).`,
    },
    servers: [{ url: opts.serverUrl }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/processos": {
        post: {
          summary: "Enviar um processo recebido",
          description:
            "Requer a permissão intake:create. Envie o cabeçalho Idempotency-Key para poder repetir a requisição com segurança: " +
            "a mesma chave com o mesmo corpo devolve a mesma resposta (cabeçalho Idempotent-Replayed: true); com outro corpo, 422.",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", minLength: 1, maxLength: 200 },
            },
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/InboundProcess" } } },
          },
          responses: {
            "201": {
              description: "Processo registrado e encaminhado ao fluxo de entrada.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/InboundResult" } } },
            },
            "200": {
              description: "O número já existia: documentos anexados e nota registrada na entrada (status updated_existing).",
              content: { "application/json": { schema: { $ref: "#/components/schemas/InboundResult" } } },
            },
            "400": errorResponse("Dados inválidos (fieldErrors), JSON inválido ou Idempotency-Key inválida."),
            "401": errorResponse("Chave ausente, inválida, revogada ou expirada."),
            "403": errorResponse("A chave não tem a permissão intake:create."),
            "409": errorResponse("Requisição com a mesma Idempotency-Key ainda em processamento."),
            "413": errorResponse("Corpo maior que o limite."),
            "415": errorResponse("Corpo que não é JSON."),
            "422": errorResponse("Idempotency-Key já usada com outro conteúdo."),
            "429": errorResponse("Limite de requisições por minuto atingido (veja Retry-After)."),
            "500": errorResponse("Falha interna; pode repetir com a mesma Idempotency-Key."),
          },
        },
      },
      "/api/v1/processos/{numero}": {
        get: {
          summary: "Consultar a situação de um processo enviado",
          description:
            "Requer a permissão process:read. Só responde sobre processos recebidos pela API desta organização (404 para os demais).",
          parameters: [
            {
              name: "numero",
              in: "path",
              required: true,
              description: "Número CNJ com ou sem pontuação.",
              schema: { type: "string", examples: ["0000123-45.2026.5.10.0001", "00001234520265100001"] },
            },
          ],
          responses: {
            "200": {
              description: "Situação resumida.",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ProcessStatus" } } },
            },
            "400": errorResponse("Número fora do padrão CNJ."),
            "401": errorResponse("Chave ausente, inválida, revogada ou expirada."),
            "403": errorResponse("A chave não tem a permissão process:read."),
            "404": errorResponse("Processo não encontrado entre os recebidos por API."),
            "429": errorResponse("Limite de requisições por minuto atingido."),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: 'Chave criada em Administração, Integrações, API de entrada ("prt_...").' },
      },
      schemas: {
        Error: errorSchema,
        InboundProcess: {
          type: "object",
          required: ["numero", "partes", "origem"],
          properties: {
            numero: { type: "string", description: "Número CNJ (20 dígitos, com ou sem pontuação)." },
            tribunal: { type: "string", maxLength: 120, description: "Ex.: TRT10. Sem ele, usa o DataJud ou o número." },
            orgaoJulgador: { type: "string", maxLength: 200 },
            cidade: { type: "string", maxLength: 120 },
            uf: { type: "string", pattern: "^[A-Za-z]{2}$" },
            classe: { type: "string", maxLength: 40 },
            area: { type: "string", enum: [...LEGAL_AREAS], description: "Padrão: labor para a Justiça do Trabalho, other nos demais." },
            fase: {
              type: "string",
              enum: [...PROCESS_PHASES],
              description: "Conhecimento, liquidação ou execução. Padrão: knowledge. Recurso não é fase: informe a instância.",
            },
            instancia: {
              type: "string",
              enum: [...PROCESS_INSTANCES],
              description: "first = 1º grau, second = 2º grau, superior = 3º grau (TST). Padrão: first.",
            },
            ajuizadoEm: { type: "string", format: "date" },
            valorDaCausa: {
              type: "string",
              pattern: "^\\d{1,13}(\\.\\d{1,2})?$",
              description: 'Decimal com ponto, ex.: "12345.67". Nunca somado ao valor apurado.',
            },
            partes: {
              type: "array",
              minItems: 1,
              maxItems: INBOUND_MAX_PARTIES,
              description: "Ao menos uma parte no polo ativo; a ré vem do polo passivo ou da empresa.",
              items: {
                type: "object",
                required: ["nome", "polo"],
                properties: {
                  nome: { type: "string", maxLength: 200 },
                  polo: { type: "string", enum: [...INBOUND_POLOS] },
                  documento: { type: "string", description: "CPF (11 dígitos) ou CNPJ (14 dígitos)." },
                },
              },
            },
            empresaCnpj: { type: "string", description: "CNPJ da empresa do grupo (numérico ou alfanumérico)." },
            empresaNome: { type: "string", maxLength: 200 },
            documentos: {
              type: "array",
              maxItems: INBOUND_MAX_DOCUMENTS,
              description: `PDF, DOCX ou TXT (tipo conferido pelo conteúdo), até ${opts.maxUploadMb} MB cada.`,
              items: {
                type: "object",
                required: ["titulo", "nomeArquivo", "conteudoBase64"],
                properties: {
                  titulo: { type: "string", maxLength: 200 },
                  categoria: { type: "string", enum: [...DOCUMENT_CATEGORIES], description: "Padrão: other." },
                  nomeArquivo: { type: "string", maxLength: 180, examples: ["peticao-inicial.pdf"] },
                  conteudoBase64: { type: "string", contentEncoding: "base64" },
                },
              },
            },
            origem: {
              type: "object",
              required: ["sistema"],
              properties: { sistema: { type: "string", maxLength: 80 }, referencia: { type: "string", maxLength: 120 } },
            },
            observacao: { type: "string", maxLength: 2000 },
          },
        },
        InboundResult: {
          type: "object",
          properties: {
            processId: { type: "string", format: "uuid" },
            intakeId: { type: ["string", "null"], format: "uuid" },
            status: { type: "string", enum: ["accepted", "updated_existing"] },
            number: { type: "string" },
            documents: { type: "integer" },
            datajud: { type: "string", description: "O que aconteceu com o enriquecimento pelo DataJud." },
            replayed: { type: "boolean", description: "Presente quando a resposta é a repetição de uma Idempotency-Key." },
            links: { type: "object", additionalProperties: { type: "string", format: "uri" } },
          },
        },
        ProcessStatus: {
          type: "object",
          properties: {
            number: { type: "string" },
            processId: { type: "string", format: "uuid" },
            status: { type: "string" },
            statusLabel: { type: "string" },
            phase: { type: "string" },
            phaseLabel: { type: "string" },
            instance: { type: ["string", "null"] },
            instanceLabel: { type: ["string", "null"] },
            responsibleName: { type: ["string", "null"] },
            intake: {
              type: ["object", "null"],
              properties: {
                id: { type: "string", format: "uuid" },
                status: { type: "string" },
                statusLabel: { type: "string" },
                receivedAt: { type: "string", format: "date-time" },
              },
            },
            preliminaryAnalysis: {
              type: ["object", "null"],
              description: "Análise preliminar (simulação demonstrativa).",
              properties: { status: { type: "string" }, statusLabel: { type: "string" }, simulated: { type: "boolean" } },
            },
            links: { type: "object", additionalProperties: { type: "string", format: "uri" } },
          },
        },
      },
    },
  };
}
