import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import type { Option } from "@/lib/options";
import { idParam } from "@/lib/search-params";
import { DocumentUploadForm } from "@/modules/documents/components/document-upload-form";
import { loadLinkOptions } from "@/modules/documents/link-options";
import { requirePageContext } from "@/server/auth/session";
import { env } from "@/server/env";

export const metadata: Metadata = { title: "Novo documento" };

/** Keeps a preselected id only when it is one of the options visible to the user. */
function preselect(options: Option[], id: string | undefined): string | undefined {
  return id && options.some((o) => o.value === id) ? id : undefined;
}

export default async function NewDocumentPage(props: PageProps<"/documentos/novo">) {
  const ctx = await requirePageContext("document:upload");
  const sp = await props.searchParams;
  // The preselected process is offered even beyond the option list limit (when visible to the user).
  const options = await loadLinkOptions(ctx, { includeProcessId: idParam(sp, "processo") });

  return (
    <>
      <PageHeader
        title="Novo documento"
        description="Envie um arquivo e, se for o caso, vincule-o a um processo, ocorrência ou contrato."
        breadcrumbs={[
          { label: "Painel executivo", href: "/dashboard" },
          { label: "Documentos", href: "/documentos" },
          { label: "Novo documento" },
        ]}
      />
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Dados do documento</CardTitle>
          <CardDescription>
            Após o envio, o texto do arquivo é extraído automaticamente em segundo plano para busca e análises de IA.
            Imagens ainda não têm extração de texto (OCR pendente).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DocumentUploadForm
            mode="document"
            maxUploadMb={env().MAX_UPLOAD_MB}
            processOptions={options.processes}
            occurrenceOptions={options.occurrences}
            contractOptions={options.contracts}
            defaultLinks={{
              processId: preselect(options.processes, idParam(sp, "processo")),
              occurrenceId: preselect(options.occurrences, idParam(sp, "ocorrencia")),
              contractId: preselect(options.contracts, idParam(sp, "contrato")),
            }}
            afterUpload="open"
          />
        </CardContent>
      </Card>
    </>
  );
}
