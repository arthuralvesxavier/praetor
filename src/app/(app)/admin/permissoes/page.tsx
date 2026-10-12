import { Check, Minus } from "lucide-react";
import type { Metadata } from "next";
import { Fragment } from "react";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, ROLES } from "@/domain/enums";
import { formatNumber } from "@/lib/format";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { requireAdminAreaContext } from "@/modules/admin/guard";
import { groupPermissions } from "@/modules/admin/permission-groups";
import { PERMISSION_LABELS, PERMISSIONS, ROLE_PERMISSIONS } from "@/server/auth/permissions";

export const metadata: Metadata = { title: "Permissões" };

/** Plain-language version of the record visibility rules in src/server/auth/access.ts. */
const VISIBILITY_RULES: { title: string; text: string }[] = [
  {
    title: "Isolamento por organização",
    text: "Cada usuário só acessa dados da própria organização. Não há exceções.",
  },
  {
    title: "Registros excluídos",
    text: "Registros excluídos nunca aparecem em consultas, listas ou indicadores.",
  },
  {
    title: "Administrador e Gestor jurídico",
    text: "Veem todos os registros da organização, inclusive os sigilosos e os documentos restritos.",
  },
  {
    title: "Diretoria, Contabilidade e Auditoria",
    text: "Veem todos os registros não sigilosos da organização. O que podem fazer com eles depende das permissões do perfil (a Diretoria e a Auditoria apenas consultam; a Contabilidade lança e confere valores).",
  },
  {
    title: "Advogado e Analista",
    text: "Veem os registros não sigilosos da sua unidade (ou sem unidade), além de qualquer registro em que sejam o responsável ou quem o cadastrou.",
  },
  {
    title: "Escritório externo",
    text: "Não tem unidade: vê somente os processos atribuídos ao seu escritório (inclusive sigilosos, por patrocinar o caso) e os registros em que é responsável ou quem cadastrou. Ocorrências e contratos apenas quando for o responsável.",
  },
  {
    title: "Valores, garantias, acordos, audiências e entradas",
    text: "Registros que pertencem a um processo seguem a visibilidade do processo. Análises preliminares exigem, além disso, que todos os documentos usados como fonte sejam visíveis.",
  },
  {
    title: "Prazos e tarefas",
    text: "Prazos e tarefas vinculados a um processo, ocorrência ou contrato seguem a visibilidade desse registro; os sem vínculo seguem a regra da unidade. O responsável, a pessoa atribuída e quem cadastrou sempre veem o próprio item.",
  },
  {
    title: "Documentos",
    text: "Seguem a visibilidade de todos os registros a que estão vinculados e o nível de confidencialidade. Interno: quem vê os registros vinculados. Confidencial: administrador, gestor jurídico, advogados e escritório externo (além de quem enviou). Restrito: administrador, gestor jurídico, quem enviou e o responsável por um registro vinculado.",
  },
  {
    title: "Dados sensíveis de saúde",
    text: "Atestados, laudos e CATs ficam restritos ao administrador, ao gestor jurídico, a quem enviou e ao responsável por um registro vinculado (ou ao escritório do processo).",
  },
  {
    title: "Análises de IA",
    text: "Uma análise é visível quando o seu assunto é visível e todos os documentos usados como fonte também são. Perguntas e respostas são privadas de quem perguntou.",
  },
  {
    title: "E-mails simulados",
    text: "Administrador e gestor jurídico veem todos. Os demais veem as mensagens destinadas a eles ou geradas por eles e as mensagens sobre processos que podem ver.",
  },
  {
    title: "Alertas e comentários",
    text: "Seguem a visibilidade do registro a que se referem.",
  },
];

export default async function PermissionsPage() {
  const ctx = await requireAdminAreaContext();
  const groups = groupPermissions(PERMISSIONS);

  return (
    <>
      <PageHeader
        title="Permissões"
        description="O que cada perfil pode fazer e quais registros cada pessoa pode ver. Esta matriz é definida pelo sistema e não é editável."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Permissões" }]}
      />
      <AdminNav ctx={ctx} active="permissoes" />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Perfis de acesso</CardTitle>
            <CardDescription>Os oito perfis disponíveis e a quantidade de permissões de cada um.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {ROLES.map((role) => (
                <div key={role} className="rounded-md border border-border bg-surface-muted p-3">
                  <dt className="flex items-baseline justify-between gap-2 text-sm font-semibold text-slate-900">
                    {ROLE_LABELS[role]}
                    <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                      {formatNumber(ROLE_PERMISSIONS[role].length)} de {formatNumber(PERMISSIONS.length)}
                    </span>
                  </dt>
                  <dd className="mt-1 text-xs text-slate-700">{ROLE_DESCRIPTIONS[role]}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card className="pb-0">
          <CardHeader>
            <CardTitle>Matriz de permissões por perfil</CardTitle>
            <CardDescription>
              Ações permitidas a cada perfil, agrupadas por área. Mesmo com a permissão, a pessoa só atua sobre os registros
              que pode ver (regras abaixo).
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table aria-label="Matriz de permissões por perfil">
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 min-w-56 bg-slate-50">Permissão</TableHead>
                  {ROLES.map((role) => (
                    <TableHead key={role} scope="col" className="min-w-24 text-center text-xs leading-tight whitespace-normal">
                      {ROLE_LABELS[role]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <Fragment key={group.key}>
                    <TableRow className="bg-surface-muted hover:bg-surface-muted">
                      <TableHead
                        scope="colgroup"
                        colSpan={ROLES.length + 1}
                        className="sticky left-0 bg-surface-muted text-xs font-semibold tracking-wide text-slate-700 uppercase"
                      >
                        {group.label}
                      </TableHead>
                    </TableRow>
                    {group.permissions.map((permission) => (
                      <TableRow key={permission}>
                        <TableHead scope="row" className="sticky left-0 z-10 max-w-72 min-w-56 bg-surface py-2 font-normal whitespace-normal text-slate-800">
                          {PERMISSION_LABELS[permission]}
                          <code className="block text-[11px] text-muted-foreground">{permission}</code>
                        </TableHead>
                        {ROLES.map((role) => {
                          const allowed = ROLE_PERMISSIONS[role].includes(permission);
                          return (
                            <TableCell key={role} className="text-center">
                              {allowed ? (
                                <Check aria-hidden="true" className="mx-auto size-4 text-emerald-600" />
                              ) : (
                                <Minus aria-hidden="true" className="mx-auto size-4 text-slate-300" />
                              )}
                              <span className="sr-only">
                                {ROLE_LABELS[role]}: {allowed ? "permitido" : "não permitido"}
                              </span>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Callout tone="info" title="Perfis de consulta">
          Diretoria / executivo e Auditoria e compliance consultam painéis, carteira, relatórios e (no caso da Auditoria) a
          trilha de auditoria de registros não sigilosos, mas não cadastram, alteram, excluem, validam nem solicitam análises.
        </Callout>

        <Card>
          <CardHeader>
            <CardTitle>Regras de visibilidade dos registros</CardTitle>
            <CardDescription>
              Aplicadas no servidor em todas as consultas. Esconder um botão nunca é a única proteção.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 md:grid-cols-2">
              {VISIBILITY_RULES.map((rule) => (
                <div key={rule.title} className="rounded-md border border-border bg-surface-muted p-4">
                  <dt className="text-sm font-semibold text-slate-900">{rule.title}</dt>
                  <dd className="mt-1 text-sm text-slate-700">{rule.text}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
