/**
 * pt-BR labels of the short error codes stored in `inbound_requests.error_code`
 * (the API answers keep the English codes, which are part of the contract in
 * docs/API.md; screens show these labels). Client-safe.
 */
export const INBOUND_ERROR_CODE_LABELS: Readonly<Record<string, string>> = {
  validation: "dados inválidos",
  bad_request: "requisição inválida",
  documents: "documentos recusados (quantidade, tamanho ou formato)",
  invalid_json: "corpo não é um JSON válido",
  unsupported_media_type: "formato do corpo não aceito",
  payload_too_large: "corpo acima do limite",
  invalid_idempotency_key: "Idempotency-Key inválida",
  idempotency_conflict: "Idempotency-Key repetida com conteúdo diferente",
  request_in_progress: "envio com a mesma Idempotency-Key ainda em processamento",
  rate_limited: "limite de requisições por minuto atingido",
  forbidden_scope: "chave sem a permissão necessária",
  forbidden: "operação não permitida",
  unauthorized: "chave ausente ou inválida",
  unauthenticated: "chave ausente ou inválida",
  not_found: "processo não encontrado",
  conflict: "conflito com um registro existente",
  budget_exceeded: "limite de uso atingido",
  internal: "falha interna ao registrar",
};

/** Label of an error code; unknown codes are not shown raw. */
export function inboundErrorLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return INBOUND_ERROR_CODE_LABELS[code] ?? "erro não catalogado";
}
