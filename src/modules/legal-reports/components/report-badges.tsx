import { Badge } from "@/components/ui/badge";
import {
  LEGAL_REPORT_STATUS_LABELS,
  REPORT_ITEM_ORIGIN_DESCRIPTIONS,
  REPORT_ITEM_ORIGIN_LABELS,
  type LegalReportStatus,
  type ReportItemOrigin,
} from "@/domain/enums";
import { LEGAL_REPORT_STATUS_TONES, REPORT_ITEM_ORIGIN_TONES } from "../labels";

/** Selo de origem de um item (cor E texto; a descrição vai no title e para leitores de tela). */
export function OriginSeal({ origin }: { origin: ReportItemOrigin }) {
  return (
    <Badge tone={REPORT_ITEM_ORIGIN_TONES[origin]} title={REPORT_ITEM_ORIGIN_DESCRIPTIONS[origin]} className="uppercase tracking-wide">
      <span className="sr-only">Origem: </span>
      {REPORT_ITEM_ORIGIN_LABELS[origin]}
    </Badge>
  );
}

export function LegalReportStatusBadge({ status }: { status: LegalReportStatus }) {
  return (
    <Badge tone={LEGAL_REPORT_STATUS_TONES[status]} dot>
      {LEGAL_REPORT_STATUS_LABELS[status]}
    </Badge>
  );
}

export function SampleBadge() {
  return <Badge tone="neutral">Teste do motor</Badge>;
}
