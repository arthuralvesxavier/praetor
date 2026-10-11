import { Check, Minus } from "lucide-react";
import type { Metadata } from "next";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROLE_LABELS, ROLES } from "@/domain/enums";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { requireAdminAreaContext } from "@/modules/admin/guard";
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
    text: "Veem todos os registros da organização, inclusive os confidenciais e os documentos restritos.",
  },
  {
    title: "Executivo",
    text: "Vê todos os registros não confidenciais da organização, apenas para consulta: o perfil não cadastra, edita, comenta nem solicita análises.",
  },
  {
    title: "Advogado e Analista",
    text: "Veem os registros não confidenciais da sua unidade (ou sem unidade), além de qualquer registro em que sejam o responsável ou quem o cadastrou.",
  },
  {
    title: "Prazos e tarefas",
    text: "Prazos e tarefas vinculados a um processo, ocorrência ou contrato seguem a visibilidade desse registro; os sem vínculo seguem a regra da unidade. O responsável, a pessoa atribuída e quem cadastrou sempre veem o próprio item.",
  },
  {
    title: "Documentos",
    text: "Seguem a visibilidade de todos os registros a que estão vinculados e o nível de confidencialidade: Interno — quem vê os registros vinculados; Confidencial — administrador, gestor jurídico e advogados (além de quem enviou); Restrito — administrador, gestor jurídico, quem enviou e o responsável por um registro vinculado.",
  },
  {
    title: "Análises de IA",
    text: "Uma análise é visível quando o seu assunto é visível e todos os documentos usados como fonte também são. Perguntas e respostas são privadas de quem perguntou.",
  },
  {
    title: "Alertas e comentários",
    text: "Seguem a visibilidade do registro a que se referem.",
  },
];

export default async function PermissionsPage() {
  const ctx = await requireAdminAreaContext();

  return (
    <>
      <PageHeader
        title="Permissões"
        description="O que cada perfil pode fazer e quais registros cada pessoa pode ver. Esta matriz é definida pelo sistema e não é editável."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Permissões" }]}
      />
      <AdminNav ctx={ctx} active="permissoes" />

      <div className="flex flex-col gap-6">
        <Card className="pb-0">
          <CardHeader>
            <CardTitle>Matriz de permissões por perfil</CardTitle>
            <CardDescription>
              Ações permitidas a cada perfil. Mesmo com a permissão, a pessoa só atua sobre os registros que pode ver
              (regras abaixo).
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table aria-label="Matriz de permissões por perfil">
              <TableHeader>
                <TableRow>
                  <TableHead>Permissão</TableHead>
                  {ROLES.map((role) => (
                    <TableHead key={role} className="text-center whitespace-nowrap">
                      {ROLE_LABELS[role]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {PERMISSIONS.map((permission) => (
                  <TableRow key={permission}>
                    <TableHead scope="row" className="font-normal text-slate-800">
                      {PERMISSION_LABELS[permission]}
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
                          <span className="sr-only">{allowed ? "Permitido" : "Não permitido"}</span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Callout tone="info" title="Perfil Executivo: somente consulta">
          O perfil Executivo consulta dashboards, processos, ocorrências, contratos, documentos, prazos, tarefas e análises
          não confidenciais, mas não pode cadastrar, alterar, excluir, comentar, validar nem solicitar análises de IA.
        </Callout>

        <Card>
          <CardHeader>
            <CardTitle>Regras de visibilidade dos registros</CardTitle>
            <CardDescription>
              Aplicadas no servidor em todas as consultas — esconder um botão nunca é a única proteção.
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
