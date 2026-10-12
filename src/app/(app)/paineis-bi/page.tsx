import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/ui/page-header";
import { LinkTabs } from "@/components/ui/tabs";
import { param, type SearchParams } from "@/lib/search-params";
import { BiSetupState } from "@/modules/bi/components/bi-setup-state";
import { PowerBiEmbed } from "@/modules/bi/components/power-bi-embed";
import { getBiPageData } from "@/modules/bi/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Painéis Power BI" };

type Props = { searchParams: Promise<SearchParams> };

export default async function BiPanelsPage(props: Props) {
  const ctx = await requirePageContext("report:read");
  const sp = await props.searchParams;
  const data = await getBiPageData(ctx);
  const canConfigure = can(ctx, "admin:organization");
  const wanted = param(sp, "painel")?.toLowerCase();
  const selected = data.reports.find((r) => r.id.toLowerCase() === wanted) ?? data.reports[0] ?? null;

  return (
    <>
      <PageHeader
        title="Painéis Power BI"
        description="Indicadores da carteira publicados no Power BI, com as mesmas regras de acesso do Praetor."
        actions={
          canConfigure ? (
            <ButtonLink href="/admin/integracoes/power-bi" variant="outline" size="sm">
              Configurar painéis
            </ButtonLink>
          ) : null
        }
      />

      {!data.ready || !selected ? (
        <BiSetupState hint={data.setupHint} canConfigure={canConfigure} />
      ) : (
        <div className="flex flex-col gap-4">
          {data.reports.length > 1 ? (
            <LinkTabs
              label="Painéis disponíveis"
              active={selected.id}
              tabs={data.reports.map((r) => ({ key: r.id, label: r.name, href: `/paineis-bi?painel=${encodeURIComponent(r.id)}` }))}
            />
          ) : null}
          <Callout tone="info" title="Como ler estes painéis">
            Você vê apenas os processos que já pode ver no Praetor. Valor da causa e valor apurado aparecem separados e nunca
            são somados; processo sem valor apurado aparece como não apurado (não como zero), e valores estimados são
            identificados como estimativa. Os números vêm da última atualização do conjunto de dados no Power BI.
          </Callout>
          <PowerBiEmbed key={selected.id} reportId={selected.id} reportName={selected.name} />
        </div>
      )}
    </>
  );
}
