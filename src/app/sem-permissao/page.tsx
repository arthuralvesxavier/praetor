import { ShieldX } from "lucide-react";
import type { Metadata } from "next";
import { BrandStatusPage } from "@/components/brand/status-page";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = { title: "Acesso não permitido" };

/** Target of requirePageContext(permission) when the user lacks the permission (HTTP 403 equivalent). */
export default function NoPermissionPage() {
  return (
    <BrandStatusPage
      icon={<ShieldX />}
      kicker="Acesso restrito"
      title="Você não tem permissão para acessar esta página"
      actions={<ButtonLink href="/dashboard">Voltar ao painel</ButtonLink>}
    >
      <p>
        Seu perfil de acesso não inclui esta funcionalidade. Se você precisa dela para o seu trabalho, solicite a
        liberação ao administrador do Praetor na sua organização.
      </p>
    </BrandStatusPage>
  );
}
