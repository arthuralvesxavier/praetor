"use client";

import { Code2, FileText } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * HTML / text views of a stored simulated e-mail. The HTML runs in a fully
 * sandboxed iframe (`sandbox=""`: no scripts, forms, popups or same-origin
 * access) fed through `srcDoc`, so stored content can never run in the app.
 */
export function EmailBodyViewer({ html, text, subject }: { html: string; text: string; subject: string }) {
  return (
    <Tabs defaultValue="html">
      <TabsList aria-label="Formato do conteúdo">
        <TabsTrigger value="html">
          <Code2 aria-hidden="true" className="size-4" />
          Versão HTML
        </TabsTrigger>
        <TabsTrigger value="texto">
          <FileText aria-hidden="true" className="size-4" />
          Versão em texto
        </TabsTrigger>
      </TabsList>
      <TabsContent value="html" className="flex flex-col gap-2">
        <iframe
          title={`Pré-visualização HTML do e-mail simulado: ${subject}`}
          srcDoc={html}
          sandbox=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="h-[560px] w-full rounded-md border border-border bg-white sm:h-[680px]"
        />
        <p className="text-xs text-muted-foreground">
          Pré-visualização isolada: os links do e-mail ficam desativados aqui. Use os vínculos desta página para abrir
          os registros.
        </p>
      </TabsContent>
      <TabsContent value="texto">
        <pre className="max-h-[680px] overflow-auto rounded-md border border-border bg-surface-muted p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-800">
          {text}
        </pre>
      </TabsContent>
    </Tabs>
  );
}
