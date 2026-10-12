import { SearchX } from "lucide-react";
import type { Metadata } from "next";
import { BrandStatusPage } from "@/components/brand/status-page";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Página não encontrada" };

export default function NotFound() {
  return (
    <BrandStatusPage
      icon={<SearchX />}
      kicker="Erro 404"
      title="Página não encontrada"
      actions={
        <>
          <ButtonLink href="/dashboard">Ir para o painel</ButtonLink>
          <ButtonLink href="/" variant="outline">
            Página inicial
          </ButtonLink>
        </>
      }
    >
      <p>O endereço acessado não existe ou foi movido. Verifique o link ou volte para o início.</p>
    </BrandStatusPage>
  );
}
