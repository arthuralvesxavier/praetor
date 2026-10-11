import type { EntityType } from "./enums";

/** Reference to a record that documents, tasks, deadlines, comments, analyses and alerts can point to. */
export type LinkableEntityType = Extract<EntityType, "legal_process" | "occurrence" | "contract">;

export type EntityRef = {
  type: Extract<EntityType, "legal_process" | "occurrence" | "contract" | "document" | "task" | "deadline" | "analysis">;
  id: string;
};

/** Canonical UI route of each entity (pt-BR paths). */
export function entityHref(ref: EntityRef): string {
  switch (ref.type) {
    case "legal_process":
      return `/processos/${ref.id}`;
    case "occurrence":
      return `/preventivo/${ref.id}`;
    case "contract":
      return `/contratos/${ref.id}`;
    case "document":
      return `/documentos/${ref.id}`;
    case "analysis":
      return `/ia/analises/${ref.id}`;
    case "task":
      return `/prazos?aba=tarefas&tarefa=${ref.id}`;
    case "deadline":
      return `/prazos?aba=prazos&prazo=${ref.id}`;
  }
}

/** Standard pagination input/output for list services. */
export type Page = { page?: number; pageSize?: number };
export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number };

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export function normalizePage(p?: Page): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.floor(p?.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(p?.pageSize ?? DEFAULT_PAGE_SIZE)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
