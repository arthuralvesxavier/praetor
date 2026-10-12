import {
  AlertTriangle,
  CircleX,
  FilePlus2,
  FileSpreadsheet,
  GitCompareArrows,
  Layers,
  ListChecks,
  RefreshCcw,
  Scale,
} from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { StatCard } from "@/components/ui/stat-card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { formatDate, formatDateTime, formatFileSize, formatNumber } from "@/lib/format";
import { buildHref } from "@/lib/search-params";
import { IMPORT_FIELD_LABELS, issueCodeLabel, SHEET_ROLE_LABELS, SHEET_ROLE_TONES } from "../labels";
import type { ImportBatchDetail } from "../service";
import { IssueLevelBadge } from "./badges";

const FIELD_ORDER = [
  "number",
  "instance",
  "court",
  "plaintiff",
  "defendant",
  "city",
  "courtDivision",
  "processClass",
  "phase",
  "claimAmount",
  "liquidatedAmount",
] as const;

function baseDateText(batch: ImportBatchDetail): string {
  if (!batch.baseDate) return "Não informada: será pedida na confirmação";
  const date = formatDate(batch.baseDate);
  if (batch.status !== "analyzed") return `${date} (confirmada na importação)`;
  if (batch.baseDateSource === "file" && batch.baseDateHint) return `${date} (sugerida pela planilha: ${batch.baseDateHint.source})`;
  return `${date} (informada no envio)`;
}

export function BatchSummary({ batch }: { batch: ImportBatchDetail }) {
  const base = `/importacoes/${batch.id}`;
  const s = batch.stats;
  const tab = (params: Record<string, string | null>) => buildHref(base, {}, params);
  const dataSheets = batch.sheets.filter((sh) => sh.role !== "ignored");
  const pending = batch.status === "analyzed";

  return (
    <div className="flex flex-col gap-6">
      {s ? (
        <section aria-label="Números da importação" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <StatCard label="Linhas lidas" value={formatNumber(s.rowsRead)} icon={<FileSpreadsheet />} hint="Todas as abas de dados" href={tab({ aba: "linhas" })} />
          <StatCard
            label="Processos detectados"
            value={formatNumber(s.processesDetected)}
            tone="primary"
            icon={<Scale />}
            hint="Um por número CNJ; instâncias não somam"
          />
          <StatCard
            label={pending ? "Novos (a criar)" : "Novos"}
            value={formatNumber(s.toCreate)}
            tone="success"
            icon={<FilePlus2 />}
            href={tab({ aba: "linhas", acao: "create" })}
          />
          <StatCard
            label={pending ? "Atualizações previstas" : "Atualizados"}
            value={formatNumber(s.toUpdate)}
            tone="info"
            icon={<RefreshCcw />}
            href={tab({ aba: "linhas", acao: "update" })}
          />
          <StatCard label="Sem alteração" value={formatNumber(s.unchanged)} icon={<ListChecks />} href={tab({ aba: "linhas", acao: "unchanged" })} />
          <StatCard
            label="Vínculos de instância"
            value={formatNumber(s.instanceLinks)}
            tone="primary"
            icon={<Layers />}
            hint="Outras instâncias do mesmo número"
            href={tab({ aba: "linhas", acao: "merge_instance" })}
          />
          <StatCard
            label="Linhas com erro"
            value={formatNumber(s.errors)}
            tone={s.errors > 0 ? "danger" : "neutral"}
            icon={<CircleX />}
            hint="Não são importadas"
            href={tab({ aba: "linhas", nivel: "error" })}
          />
          <StatCard
            label="Linhas com alerta"
            value={formatNumber(s.warnings)}
            tone={s.warnings > 0 ? "warning" : "neutral"}
            icon={<AlertTriangle />}
            hint="Importadas, conferir"
            href={tab({ aba: "inconsistencias", nivel: "warning" })}
          />
          <StatCard
            label="Divergências entre abas"
            value={formatNumber(s.divergences)}
            tone={s.divergences > 0 ? "alert" : "neutral"}
            icon={<GitCompareArrows />}
            hint="Valores diferentes para o mesmo número"
            href={tab({ aba: "divergencias" })}
          />
          <StatCard
            label="Linhas ignoradas"
            value={formatNumber(s.ignoredRows)}
            icon={<ListChecks />}
            hint="Totais, repetidas e linhas conferidas"
            href={tab({ aba: "linhas", acao: "skip" })}
          />
        </section>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Parâmetros da importação</CardTitle>
          </CardHeader>
          <CardContent>
            <DescriptionList
              columns={1}
              items={[
                { label: "Empresa da carteira", value: batch.companyName },
                { label: "Unidade padrão", value: batch.defaultUnitName ?? "Sem unidade" },
                { label: "Data-base dos valores", value: baseDateText(batch) },
                { label: "Distribuição após confirmar", value: batch.distributeAfterCommit ? "Sim, para processos novos sem responsável" : "Não" },
                {
                  label: "Arquivo",
                  value: (
                    <span className="break-all">
                      {batch.fileName} · {formatFileSize(batch.sizeBytes)} ·{" "}
                      <span title={batch.fileSha256} className="font-mono text-xs">
                        SHA-256 {batch.fileSha256.slice(0, 12)}…
                      </span>
                    </span>
                  ),
                },
                { label: "Enviada por", value: `${batch.createdByName ?? "Usuário não informado"} em ${formatDateTime(batch.createdAt)}` },
                batch.committedAt ? { label: "Confirmada por", value: `${batch.committedByName ?? "Usuário não informado"} em ${formatDateTime(batch.committedAt)}` } : null,
                batch.rolledBackAt ? { label: "Desfeita por", value: `${batch.rolledBackByName ?? "Usuário não informado"} em ${formatDateTime(batch.rolledBackAt)}` } : null,
              ]}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Regras aplicadas</CardTitle>
            <CardDescription>Como a planilha foi interpretada.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
              <li>O número CNJ é a chave: um processo por número; cada instância vira um vínculo de instância.</li>
              <li>A aba consolidada é a base oficial; as abas por instância servem para conferência.</li>
              <li>Valores divergentes entre abas viram valores propostos para conferência e nunca sobrescrevem o oficial.</li>
              <li>Linhas de TOTAL são ignoradas e a leitura continua nas linhas seguintes.</li>
              <li>Valor vazio é “não informado” ou “não apurado”, nunca zero. Causa e liquidado nunca são somados.</li>
              <li>Dígito verificador inválido é apontado para conferência; o número nunca é corrigido.</li>
              <li>“VERIFICAR” ou “saiu do acervo” deixam o processo pendente de conferência, sem encerrá-lo.</li>
              <li>Nenhum andamento processual é criado a partir da planilha.</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card className="pb-0">
        <CardHeader>
          <CardTitle>Abas detectadas</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Abas da planilha">
            <TableHeader>
              <TableRow>
                <TableHead>Aba</TableHead>
                <TableHead>Uso</TableHead>
                <TableHead>Instância</TableHead>
                <TableHead className="text-right">Cabeçalho</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead>Observação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.sheets.map((sh) => (
                <TableRow key={sh.name}>
                  <TableCell className="font-medium">
                    {sh.role !== "ignored" ? (
                      <Link href={tab({ aba: "linhas", planilha: sh.name })} className={tableLinkClasses}>
                        {sh.name}
                      </Link>
                    ) : (
                      sh.name
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge tone={SHEET_ROLE_TONES[sh.role]} dot>
                      {SHEET_ROLE_LABELS[sh.role]}
                    </Badge>
                  </TableCell>
                  <TableCell>{sh.instance ? PROCESS_INSTANCE_LABELS[sh.instance] : sh.role === "consolidated" ? "Todas (coluna Instância)" : <span className="text-muted-foreground">Não se aplica</span>}</TableCell>
                  <TableCell className="text-right">{sh.headerRow ? `linha ${sh.headerRow}` : <span className="text-muted-foreground">Não encontrado</span>}</TableCell>
                  <TableCell className="text-right">{sh.role === "ignored" ? <span className="text-muted-foreground">Não lida</span> : formatNumber(sh.rowCount)}</TableCell>
                  <TableCell className="min-w-56 text-sm text-muted-foreground">{sh.note ?? "Sem observação"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="pb-0">
        <CardHeader>
          <CardTitle>Mapeamento de colunas</CardTitle>
          <CardDescription>Coluna da planilha usada para cada campo do sistema (cabeçalhos reconhecidos por sinônimos).</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Mapeamento de colunas">
            <TableHeader>
              <TableRow>
                <TableHead>Campo do sistema</TableHead>
                {dataSheets.map((sh) => (
                  <TableHead key={sh.name}>{sh.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {dataSheets.length === 0 ? (
                <TableEmpty colSpan={1} message="Nenhuma aba de dados reconhecida." />
              ) : (
                FIELD_ORDER.map((field) => (
                  <TableRow key={field}>
                    <TableHead scope="row" className="font-medium text-slate-800">
                      {IMPORT_FIELD_LABELS[field]}
                    </TableHead>
                    {dataSheets.map((sh) => {
                      const header = batch.columnMapping[sh.name]?.[field];
                      return (
                        <TableCell key={sh.name} className={header ? "" : "text-muted-foreground"}>
                          {header ?? "Coluna ausente"}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="pb-0">
        <CardHeader>
          <CardTitle>Inconsistências por tipo</CardTitle>
          <CardDescription>Quantidade de linhas com cada ocorrência. Erros impedem a importação da linha; alertas e informações não.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table aria-label="Inconsistências por tipo">
            <TableHeader>
              <TableRow>
                <TableHead>Nível</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead>
                  <span className="sr-only">Ações</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.issueSummary.length === 0 ? (
                <TableEmpty colSpan={4} message="Nenhuma inconsistência encontrada." />
              ) : (
                batch.issueSummary.map((i) => (
                  <TableRow key={`${i.level}:${i.code}`}>
                    <TableCell>
                      <IssueLevelBadge level={i.level} />
                    </TableCell>
                    <TableCell>{issueCodeLabel(i.code)}</TableCell>
                    <TableCell className="text-right">{formatNumber(i.rows)}</TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={tab({ aba: "inconsistencias", codigo: i.code })}
                        className={tableLinkClasses}
                        aria-label={`Ver ocorrências: ${issueCodeLabel(i.code)}`}
                      >
                        Ver
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
