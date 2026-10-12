import type { PowerBiCredentials } from "./config";

/**
 * Cliente REST mínimo do Power BI ("app owns data", service principal):
 *
 *  - token do Microsoft Entra ID por client credentials (escopo do Power BI);
 *  - dados do relatório (embedUrl, conjunto de dados);
 *  - GenerateToken (V2) com identidade efetiva (RLS): o Power BI aplica o papel
 *    informado com USERNAME() = chave do usuário no Praetor;
 *  - atualização (refresh) de conjunto de dados e consulta da última atualização.
 *
 * Segurança: o segredo do aplicativo e os tokens nunca aparecem em mensagens de
 * erro, logs ou valores devolvidos ao navegador (somente o token de incorporação,
 * de curta duração, vai para a página que exibe o relatório).
 */

const POWERBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const REQUEST_TIMEOUT_MS = 20_000;
/** Renova o token do Entra ID com esta folga antes de expirar. */
const TOKEN_SAFETY_MS = 5 * 60_000;

export type PowerBiErrorCode =
  | "auth_failed"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "unavailable"
  | "network"
  | "invalid_response";

/**
 * Falha ao falar com o Entra ID ou com o Power BI. `message` é técnico e
 * saneado (status + código curto do serviço); `userMessage` é o texto pt-BR
 * que pode ser exibido e gravado no histórico.
 */
export class PowerBiError extends Error {
  readonly code: PowerBiErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly userMessage: string;
  /** Código curto devolvido pelo serviço (ex.: "AADSTS7000215", "PowerBINotAuthorizedException"). */
  readonly serviceCode: string | null;

  constructor(opts: {
    code: PowerBiErrorCode;
    status: number | null;
    retryable: boolean;
    userMessage: string;
    serviceCode?: string | null;
  }) {
    super(`powerbi_${opts.code}${opts.status ? `_${opts.status}` : ""}${opts.serviceCode ? `:${opts.serviceCode}` : ""}`);
    this.name = "PowerBiError";
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.userMessage = opts.userMessage;
    this.serviceCode = opts.serviceCode ?? null;
  }
}

// ---------------------------------------------------------------------------
// Transport (injectable for tests)
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let fetchOverride: FetchLike | null = null;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Tests only: replaces `fetch` (null restores it) and clears the token cache. */
export function setPowerBiFetchForTesting(fn: FetchLike | null): void {
  fetchOverride = fn;
  tokenCache.clear();
}

export function clearPowerBiTokenCache(): void {
  tokenCache.clear();
}

async function send(url: string, init: RequestInit): Promise<Response> {
  const doFetch: FetchLike = fetchOverride ?? ((input, i) => fetch(input, i));
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new PowerBiError({
      code: "network",
      status: null,
      retryable: true,
      userMessage: "Não foi possível conectar ao Power BI (rede indisponível ou tempo esgotado). Tente novamente.",
    });
  }
}

/** Short, safe service code from an error body (never the full payload). */
async function serviceCodeOf(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    const aad = /AADSTS\d{4,8}/.exec(text);
    if (aad) return aad[0];
    const parsed = JSON.parse(text) as { error?: { code?: unknown } | string; code?: unknown };
    const raw =
      typeof parsed.error === "object" && parsed.error ? parsed.error.code : typeof parsed.error === "string" ? parsed.error : parsed.code;
    return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function failure(res: Response, stage: "auth" | "api"): Promise<PowerBiError> {
  const serviceCode = await serviceCodeOf(res);
  const suffix = serviceCode ? ` (código ${serviceCode})` : "";
  const s = res.status;
  if (stage === "auth" || s === 401) {
    return new PowerBiError({
      code: "auth_failed",
      status: s,
      retryable: false,
      serviceCode,
      userMessage:
        `O Microsoft Entra ID ou o Power BI recusou as credenciais do aplicativo${suffix}. ` +
        "Confira POWERBI_TENANT_ID, POWERBI_CLIENT_ID e POWERBI_CLIENT_SECRET (o segredo pode ter expirado).",
    });
  }
  if (s === 403) {
    return new PowerBiError({
      code: "forbidden",
      status: s,
      retryable: false,
      serviceCode,
      userMessage:
        `O Power BI negou o acesso${suffix}. Confira se o uso de service principals está habilitado nas configurações ` +
        "do locatário e se o aplicativo foi adicionado ao workspace como Membro ou Administrador.",
    });
  }
  if (s === 404) {
    return new PowerBiError({
      code: "not_found",
      status: s,
      retryable: false,
      serviceCode,
      userMessage: `Workspace, relatório ou conjunto de dados não encontrado no Power BI${suffix}. Confira os ids cadastrados.`,
    });
  }
  if (s === 429) {
    return new PowerBiError({
      code: "rate_limited",
      status: s,
      retryable: true,
      serviceCode,
      userMessage:
        `O Power BI recusou por excesso de solicitações${suffix}. Na licença Pro, cada conjunto de dados aceita até 8 ` +
        "atualizações por dia. Tente mais tarde.",
    });
  }
  if (s >= 500) {
    return new PowerBiError({
      code: "unavailable",
      status: s,
      retryable: true,
      serviceCode,
      userMessage: `O Power BI está indisponível no momento${suffix}. Tente novamente em alguns minutos.`,
    });
  }
  return new PowerBiError({
    code: "bad_request",
    status: s,
    retryable: false,
    serviceCode,
    userMessage:
      `O Power BI recusou a solicitação${suffix}. Confira o papel de segurança (RLS) e os ids do workspace, do ` +
      "relatório e do conjunto de dados.",
  });
}

function invalidResponse(): PowerBiError {
  return new PowerBiError({
    code: "invalid_response",
    status: null,
    retryable: true,
    userMessage: "O Power BI devolveu uma resposta inesperada. Tente novamente.",
  });
}

// ---------------------------------------------------------------------------
// Entra ID token (client credentials)
// ---------------------------------------------------------------------------

export async function getPowerBiAccessToken(creds: PowerBiCredentials): Promise<string> {
  const cacheKey = `${creds.authorityUrl}|${creds.tenantId}|${creds.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - TOKEN_SAFETY_MS > Date.now()) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: POWERBI_SCOPE,
  });
  const res = await send(`${creds.authorityUrl}/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) throw await failure(res, "auth");
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!json || typeof json.access_token !== "string" || json.access_token === "") throw invalidResponse();
  const seconds = Number(json.expires_in);
  const expiresAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt });
  return json.access_token;
}

async function api(creds: PowerBiCredentials, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getPowerBiAccessToken(creds);
  const res = await send(`${creds.apiUrl}/v1.0/myorg${path}`, {
    ...init,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 401) clearPowerBiTokenCache();
  if (!res.ok) throw await failure(res, "api");
  return res;
}

const seg = (id: string) => encodeURIComponent(id);

// ---------------------------------------------------------------------------
// Reports and embed tokens
// ---------------------------------------------------------------------------

export type PowerBiReport = { id: string; name: string; embedUrl: string; datasetId: string | null };

function toReport(raw: unknown): PowerBiReport | null {
  const r = raw as { id?: unknown; name?: unknown; embedUrl?: unknown; datasetId?: unknown } | null;
  if (!r || typeof r.id !== "string" || typeof r.embedUrl !== "string") return null;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : r.id,
    embedUrl: r.embedUrl,
    datasetId: typeof r.datasetId === "string" ? r.datasetId : null,
  };
}

export async function getPowerBiReport(creds: PowerBiCredentials, workspaceId: string, reportId: string): Promise<PowerBiReport> {
  const res = await api(creds, `/groups/${seg(workspaceId)}/reports/${seg(reportId)}`);
  const report = toReport(await res.json().catch(() => null));
  if (!report) throw invalidResponse();
  return report;
}

export async function listPowerBiReports(creds: PowerBiCredentials, workspaceId: string): Promise<PowerBiReport[]> {
  const res = await api(creds, `/groups/${seg(workspaceId)}/reports`);
  const json = (await res.json().catch(() => null)) as { value?: unknown } | null;
  if (!json || !Array.isArray(json.value)) throw invalidResponse();
  return json.value.map(toReport).filter((r): r is PowerBiReport => r !== null);
}

export type EmbedTokenRequest = {
  reportId: string;
  datasetId: string;
  /** Effective identity (RLS): `username` is what USERNAME() returns inside the dataset. */
  identity: { username: string; roles: string[] };
  lifetimeMinutes: number;
};

export type EmbedToken = { token: string; tokenId: string | null; expiration: Date };

/**
 * GenerateToken V2 for viewing only: one report with `allowEdit: false`, one
 * dataset and the RLS identity. `targetWorkspaces` is deliberately NEVER sent:
 * it lists the workspaces where the token may create or save reports, so any
 * holder of the token (every user with report:read) could write into the
 * Praetor workspace. The workspace is used only to read the report metadata.
 */
export function embedTokenRequestBody(req: EmbedTokenRequest): Record<string, unknown> {
  return {
    datasets: [{ id: req.datasetId, xmlaPermissions: "Off" }],
    reports: [{ id: req.reportId, allowEdit: false }],
    identities: [{ username: req.identity.username, roles: req.identity.roles, datasets: [req.datasetId] }],
    lifetimeInMinutes: req.lifetimeMinutes,
  };
}

export async function generatePowerBiEmbedToken(creds: PowerBiCredentials, req: EmbedTokenRequest): Promise<EmbedToken> {
  const res = await api(creds, "/GenerateToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embedTokenRequestBody(req)),
  });
  const json = (await res.json().catch(() => null)) as { token?: unknown; tokenId?: unknown; expiration?: unknown } | null;
  if (!json || typeof json.token !== "string" || json.token === "") throw invalidResponse();
  const expiration = typeof json.expiration === "string" ? new Date(json.expiration) : null;
  const fallback = new Date(Date.now() + req.lifetimeMinutes * 60_000);
  return {
    token: json.token,
    tokenId: typeof json.tokenId === "string" ? json.tokenId : null,
    expiration: expiration && !Number.isNaN(expiration.getTime()) ? expiration : fallback,
  };
}

// ---------------------------------------------------------------------------
// Dataset refresh
// ---------------------------------------------------------------------------

/** Asks Power BI to refresh a dataset (asynchronous: 202 Accepted). */
export async function requestPowerBiDatasetRefresh(
  creds: PowerBiCredentials,
  workspaceId: string,
  datasetId: string,
): Promise<{ requestId: string | null }> {
  const res = await api(creds, `/groups/${seg(workspaceId)}/datasets/${seg(datasetId)}/refreshes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notifyOption: "NoNotification" }),
  });
  const requestId = res.headers.get("RequestId") ?? res.headers.get("x-ms-request-id");
  return { requestId: requestId && /^[A-Za-z0-9-]{1,100}$/.test(requestId) ? requestId : null };
}

export type PowerBiRefreshState = {
  /** Power BI status: "Unknown" (em andamento), "Completed", "Failed", "Disabled", "Cancelled". */
  status: string;
  requestId: string | null;
  endTime: Date | null;
  serviceExceptionCode: string | null;
};

/** Most recent refresh of a dataset, or null when there is none. */
export async function getLatestPowerBiRefresh(
  creds: PowerBiCredentials,
  workspaceId: string,
  datasetId: string,
): Promise<PowerBiRefreshState | null> {
  const res = await api(creds, `/groups/${seg(workspaceId)}/datasets/${seg(datasetId)}/refreshes?$top=1`);
  const json = (await res.json().catch(() => null)) as { value?: unknown } | null;
  if (!json || !Array.isArray(json.value)) throw invalidResponse();
  const raw = json.value[0] as
    | { status?: unknown; requestId?: unknown; endTime?: unknown; serviceExceptionJson?: unknown }
    | undefined;
  if (!raw) return null;
  let serviceExceptionCode: string | null = null;
  if (typeof raw.serviceExceptionJson === "string") {
    try {
      const code = (JSON.parse(raw.serviceExceptionJson) as { errorCode?: unknown }).errorCode;
      if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code)) serviceExceptionCode = code;
    } catch {
      serviceExceptionCode = null;
    }
  }
  const end = typeof raw.endTime === "string" ? new Date(raw.endTime) : null;
  return {
    status: typeof raw.status === "string" ? raw.status : "Unknown",
    requestId: typeof raw.requestId === "string" ? raw.requestId : null,
    endTime: end && !Number.isNaN(end.getTime()) ? end : null,
    serviceExceptionCode,
  };
}
