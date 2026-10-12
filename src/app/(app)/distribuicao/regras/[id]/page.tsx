import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { RuleForm } from "@/modules/distribution/components/rule-form";
import { loadRuleFormOptions, ruleFormDefaults } from "@/modules/distribution/form-options";
import { getRule, type RuleDetail } from "@/modules/distribution/service";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Editar regra de distribuição" };

export default async function EditDistributionRulePage(props: PageProps<"/distribuicao/regras/[id]">) {
  const ctx = await requirePageContext("distribution:manage");
  const { id } = await props.params;
  let rule: RuleDetail;
  try {
    rule = await getRule(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const options = await loadRuleFormOptions(ctx);

  return (
    <>
      <PageHeader
        title={`Editar regra: ${rule.name}`}
        description="As alterações valem para as próximas distribuições; processos já distribuídos não mudam de responsável."
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Distribuição", href: "/distribuicao?aba=regras" },
          { label: rule.name },
        ]}
      />
      <div className="max-w-5xl">
        <RuleForm
          ruleId={rule.id}
          defaults={ruleFormDefaults(rule, rule.priority)}
          {...options}
          cancelHref="/distribuicao?aba=regras"
        />
      </div>
    </>
  );
}
