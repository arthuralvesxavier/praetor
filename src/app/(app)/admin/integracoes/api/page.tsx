import { KeyRound, ListChecks, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { API_KEY_SCOPE_LABELS, INBOUND_REQUEST_STATUS_LABELS, type InboundRequestStatus } from "@/domain/enums";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { createApiKeyAction, revokeApiKeyAction } from "@/modules/api-keys/actions";
import { ApiKeyCreateForm } from "@/modules/api-keys/components/api-key-create-form";
import { inboundErrorLabel } from "@/modules/api-keys/labels";
import {
  API_KEY_STATUS_LABELS,
  countRecentInboundRequests,
  listApiKeys,
  listInboundRequests,
  type ApiKeyStatus,
} from "@/modules/api-keys/service";
import { INBOUND_REQUESTS_PER_MINUTE } from "@/modules/inbound/rate-limit";
import { requirePageContext } from "@/server/auth/session";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "API de entrada" };

const KEY_TONES: Record<ApiKeyStatus, Tone> = { active: "success", revoked: "neutral", expired: "warning" };
const REQUEST_TONES: Record<InboundRequestStatus, Tone> = {
  processing: "info",
  accepted: "success",
  updated_existing: "info",
  duplicate: "neutral",
  consulted: "neutral",
  rejected: "warning",
  failed: "danger",
};

export default async function ApiIntegrationPage() {
  const ctx = await requirePageContext("admin:organization");
  const [keys, requests, last24h] = await Promise.all([listApiKeys(ctx), listInboundRequests(ctx, { limit: 25 }), countRecentInboundRequests(ctx)]);
  const base = env().APP_URL.replace(/\/+$/, "");
  const total24h = Object.values(last24h).reduce((s, n) => s + n, 0);

  return (
    <>
      <PageHeader
        title="API de entrada de processos"
        description="Sistemas externos (ERP, portal do escritório, e-mail corporativo) enviam processos novos pela API. Cada envio entra no fluxo de entrada: distribuição, análise preliminar (simulação) e e-mail ao advogado (simulado)."
        breadcrumbs={[
          { label: "Administração", href: "/admin" },
          { label: "Integrações", href: "/admin/integracoes" },
          { label: "API de entrada" },
        ]}
      />
      <AdminNav ctx={ctx} active="integracoes" />

      <div className="flex flex-col gap-8">
        <Callout tone="info" title="Como usar">
          Envie <code>POST {base}/api/v1/processos</code> com o cabeçalho <code>Authorization: Bearer &lt;chave&gt;</code> e, de
          preferência, <code>Idempotency-Key</code>. A especificação está em{" "}
          <a href="/api/v1/openapi.json" className={tableLinkClasses}>
            /api/v1/openapi.json
          </a>{" "}
          e o guia com exemplos em docs/API.md. Limite: {formatNumber(INBOUND_REQUESTS_PER_MINUTE)} requisições por minuto por
          chave. Um número CNJ que já existe na carteira nunca vira processo duplicado: os documentos são anexados ao existente.
        </Callout>

        <div className="grid gap-6 xl:grid-cols-5">
          <Card className="xl:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
                Nova chave
              </CardTitle>
              <CardDescription>
                A chave completa aparece uma única vez. O sistema guarda só uma impressão digital (SHA-256) e o prefixo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ApiKeyCreateForm action={createApiKeyAction} />
            </CardContent>
          </Card>

          <Card className="pb-0 xl:col-span-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PlugZap aria-hidden="true" className="size-4 text-muted-foreground" />
                Chaves da organização
              </CardTitle>
              <CardDescription>Revogar é imediato e definitivo: requisições com a chave passam a receber 401.</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table aria-label="Chaves de API">
                <TableHeader>
                  <TableRow>
                    <TableHead>Chave</TableHead>
                    <TableHead>Permissões</TableHead>
                    <TableHead>Último uso</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>
                      <span className="sr-only">Ações</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.length === 0 ? (
                    <TableEmpty colSpan={5} message="Nenhuma chave criada." />
                  ) : (
                    keys.map((k) => (
                      <TableRow key={k.id} className="align-top">
                        <TableCell className="min-w-44">
                          <span className="block font-medium text-slate-900">{k.name}</span>
                          <code className="text-xs text-muted-foreground">{k.keyPrefix}…</code>
                          <span className="block text-xs text-muted-foreground">
                            Criada em {formatDateTime(k.createdAt)}
                            {k.createdByName ? ` por ${k.createdByName}` : ""}
                          </span>
                        </TableCell>
                        <TableCell className="min-w-44 text-sm">
                          {k.scopes.map((s) => (
                            <span key={s} className="block">
                              {API_KEY_SCOPE_LABELS[s]}
                            </span>
                          ))}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          {k.lastUsedAt ? formatDateTime(k.lastUsedAt) : <span className="text-muted-foreground">Nunca usada</span>}
                          {k.lastUsedIp ? <span className="block text-xs text-muted-foreground">IP {k.lastUsedIp}</span> : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <StatusBadge label={API_KEY_STATUS_LABELS[k.status]} tone={KEY_TONES[k.status]} />
                          {k.revokedAt ? (
                            <span className="block text-xs text-muted-foreground">
                              {formatDateTime(k.revokedAt)}
                              {k.revokedByName ? ` por ${k.revokedByName}` : ""}
                            </span>
                          ) : k.expiresAt ? (
                            <span className="block text-xs text-muted-foreground">Até {formatDateTime(k.expiresAt)}</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          {k.status === "active" ? (
                            <ConfirmDialog
                              action={revokeApiKeyAction}
                              hiddenFields={{ id: k.id }}
                              triggerLabel="Revogar"
                              triggerSize="sm"
                              title={`Revogar a chave "${k.name}"?`}
                              description="O sistema que usa esta chave deixa de conseguir enviar processos na hora. Não dá para desfazer: crie outra chave se precisar."
                              confirmLabel="Revogar"
                              pendingLabel="Revogando…"
                            />
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>

        <Card className="pb-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListChecks aria-hidden="true" className="size-4 text-muted-foreground" />
              Últimas requisições
            </CardTitle>
            <CardDescription>
              {formatNumber(total24h)} nas últimas 24 horas. O conteúdo enviado nunca é guardado no registro: só o resultado, os
              identificadores gerados e uma impressão digital do corpo (para a idempotência).
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table aria-label="Últimas requisições da API de entrada">
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Chave</TableHead>
                  <TableHead>Rota</TableHead>
                  <TableHead>Resultado</TableHead>
                  <TableHead>Processo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.length === 0 ? (
                  <TableEmpty colSpan={5} message="Nenhuma requisição recebida ainda." />
                ) : (
                  requests.map((r) => (
                    <TableRow key={r.id} className="align-top">
                      <TableCell className="whitespace-nowrap">{formatDateTime(r.createdAt)}</TableCell>
                      <TableCell>{r.apiKeyName}</TableCell>
                      <TableCell>
                        <code className="text-xs">{r.endpoint}</code>
                      </TableCell>
                      <TableCell className="min-w-44">
                        <StatusBadge label={INBOUND_REQUEST_STATUS_LABELS[r.status] ?? r.status} tone={REQUEST_TONES[r.status] ?? "neutral"} />
                        <span className="block text-xs text-muted-foreground">
                          {r.httpStatus ? `HTTP ${r.httpStatus}` : "Em andamento"}
                          {r.errorCode ? `: ${inboundErrorLabel(r.errorCode)}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.processId && r.processNumber ? (
                          <Link href={`/processos/${r.processId}`} className={tableLinkClasses}>
                            {r.processNumber}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">Nenhum</span>
                        )}
                        {r.intakeId ? (
                          <Link href={`/entrada/${r.intakeId}`} className={`${tableLinkClasses} block text-xs`}>
                            Ver a entrada
                          </Link>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
