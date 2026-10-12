import { BellRing } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { NOTICE_DATE_LABEL, noticeRelativeText, type NoticeInfo } from "../vigencia";

/**
 * Renewal/termination notice pill, only when it needs attention: "aviso em 12
 * dias" (soon, amber) or "prazo de aviso encerrado há 3 dias" (passed, red).
 */
export function NoticeBadge({ notice, className }: { notice: NoticeInfo; className?: string }) {
  if (notice.state !== "soon" && notice.state !== "passed") return null;
  return (
    <Badge tone={notice.state === "passed" ? "danger" : "warning"} icon={<BellRing />} className={className}>
      <span className="sr-only">{NOTICE_DATE_LABEL}: </span>
      {noticeRelativeText(notice.days)}
    </Badge>
  );
}
