import Link from "next/link";
import { tableLinkClasses } from "@/components/ui/table";
import { ENTITY_TYPE_LABELS } from "@/domain/enums";
import { entityHref } from "@/domain/entities";
import { cn } from "@/lib/utils";
import type { DocumentLink } from "../service";

/** Links of a document to processes/occurrences/contracts (hidden records are shown without a link). */
export function DocumentLinks({ links, className }: { links: readonly DocumentLink[]; className?: string }) {
  if (links.length === 0) return <span className="text-muted-foreground">Sem vínculo</span>;
  return (
    <ul className={cn("flex flex-col gap-0.5", className)}>
      {links.map((l) => (
        <li key={`${l.type}-${l.id}`} className="min-w-0">
          <span className="text-xs text-muted-foreground">{ENTITY_TYPE_LABELS[l.type]}: </span>
          {l.label ? (
            <Link href={entityHref({ type: l.type, id: l.id })} className={cn(tableLinkClasses, "break-words")}>
              {l.label}
            </Link>
          ) : (
            <span className="text-muted-foreground italic">registro sem acesso</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function downloadHref(documentId: string, versionId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(versionId)}/download`;
}
