import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { RuleForm } from "@/modules/distribution/components/rule-form";
import { loadRuleFormOptions, ruleFormDefaults } from "@/modules/distribution/form-options";
import { listRules } from "@/modules/distribution/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Nova regra de distribuição" };

export default async function NewDistributionRulePage() {
  const ctx = await requirePageContext("distribution:manage");
  const [options, rules] = await Promise.all([loadRuleFormOptions(ctx), listRules(ctx)]);
  const nextPriority = rules.reduce((max, r) => Math.max(max, r.priority), 0) + 10;

  return (
    <>
      <PageHeader
        title="Nova regra de distribuição"
        description="Defina quando a regra se aplica e quem recebe os processos. Ela passa a valer para as próximas entradas."
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Distribuição", href: "/distribuicao?aba=regras" },
          { label: "Nova regra" },
        ]}
      />
      <div className="max-w-5xl">
        <RuleForm defaults={ruleFormDefaults(null, nextPriority)} {...options} cancelHref="/distribuicao?aba=regras" />
      </div>
    </>
  );
}
