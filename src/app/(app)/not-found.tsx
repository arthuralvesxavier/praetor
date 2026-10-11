import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/** Rendered by notFound() inside the app shell. Same message whether the record is missing or not visible. */
export default function AppNotFound() {
  return (
    <div className="py-6">
      <EmptyState
        icon={<SearchX />}
        title="Registro não encontrado"
        description="O endereço não existe ou você não tem permissão para acessar este registro."
        action={<ButtonLink href="/dashboard">Voltar ao dashboard</ButtonLink>}
      />
    </div>
  );
}
