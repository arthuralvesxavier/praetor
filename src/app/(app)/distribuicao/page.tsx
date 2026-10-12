import { Plus } from "lucide-react";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { LinkTabs } from "@/components/ui/tabs";
import { buildHref, enumParam, idParam, param } from "@/lib/search-params";
import { RuleTestPanel } from "@/modules/distribution/components/rule-test-panel";
import { RulesTable } from "@/modules/distribution/components/rules-table";
import { WorkloadPanel } from "@/modules/distribution/components/workload-panel";
import {
  getWorkload,
  listAssignableUsers,
  listRules,
  previewAssignment,
  type AssignmentPreview,
} from "@/modules/distribution/service";
import { searchProcesses } from "@/modules/processes/service";
import { requirePageContext } from "@/server/auth/session";
import { AppError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Distribuição de demandas" };

const TABS = ["regras", "carga"] as const;

export default async function DistributionPage(props: PageProps<"/distribuicao">) {
  const ctx = await requirePageContext("distribution:manage");
  const sp = await props.searchParams;
  const tab = enumParam(sp, "aba", TABS) ?? "regras";

  const tabs = [
    { key: "regras", label: "Regras", href: buildHref("/distribuicao", {}, { aba: "regras" }) },
    { key: "carga", label: "Carga de trabalho", href: buildHref("/distribuicao", {}, { aba: "carga" }) },
  ];

  return (
    <>
      <PageHeader
        title="Distribuição de demandas"
        description="Regras que definem quem recebe cada processo novo e a carga de trabalho atual da equipe e dos escritórios externos."
        breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Distribuição" }]}
        actions={
          tab === "regras" ? (
            <ButtonLink href="/distribuicao/regras/nova">
              <Plus aria-hidden="true" />
              Nova regra
            </ButtonLink>
          ) : null
        }
      />
      <LinkTabs tabs={tabs} active={tab} label="Seções da distribuição" className="mb-6" />
      {tab === "regras" ? <RulesTab ctx={ctx} sp={sp} /> : <WorkloadPanel workload={await getWorkload(ctx)} />}
    </>
  );
}

async function RulesTab({
  ctx,
  sp,
}: {
  ctx: Awaited<ReturnType<typeof requirePageContext>>;
  sp: Awaited<PageProps<"/distribuicao">["searchParams"]>;
}) {
  const query = param(sp, "teste");
  const processId = idParam(sp, "processo");
  const [rules, users, results] = await Promise.all([
    listRules(ctx),
    listAssignableUsers(ctx),
    query ? searchProcesses(ctx, query, 8) : Promise.resolve([]),
  ]);
  let preview: AssignmentPreview | null = null;
  let previewError: string | null = null;
  if (processId) {
    try {
      preview = await previewAssignment(ctx, processId);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      previewError = err.message;
    }
  }

  return (
    <div className="grid gap-6">
      <Callout tone="info" title="Como a distribuição funciona">
        As regras ativas são avaliadas em ordem (prioridade menor primeiro). A primeira cujos critérios são todos
        atendidos pelo processo — e que tenha alguém ativo para receber — decide o responsável. Se nenhuma se aplicar, o
        processo vai para o advogado com menor carga da unidade do processo (ou de toda a organização). Processos que já
        chegam com responsável o mantêm.
      </Callout>
      <Card className="py-0">
        <RulesTable rules={rules} />
      </Card>
      {previewError ? (
        <Callout tone="warning" role="alert">
          {previewError}
        </Callout>
      ) : null}
      <RuleTestPanel
        sp={sp}
        query={query}
        results={results.map((r) => ({ id: r.id, number: r.number, title: r.title, court: r.court }))}
        preview={preview}
        users={users.map((u) => ({ value: u.id, label: `${u.name} — ${u.roleLabel}${u.unitName ? ` · ${u.unitName}` : ""}` }))}
      />
    </div>
  );
}
