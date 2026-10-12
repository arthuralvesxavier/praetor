/**
 * Demonstração da API de entrada: este script faz o papel de um SISTEMA
 * EXTERNO (ex.: ERP jurídico) enviando um processo FICTÍCIO para o Praetor.
 *
 *   PRAETOR_API_KEY=prt_... npx tsx scripts/demo-api-push.ts
 *   PRAETOR_API_URL=http://localhost:3000 (padrão)   --dry-run (só mostra o resumo, não envia)
 *
 * Crie a chave em Administração, Integrações, API de entrada (permissão
 * "Enviar processos novos"). O caso é inteiramente fictício: número CNJ com
 * dígito verificador válido mas unidade de origem 9999 (inexistente, então o
 * DataJud não encontra nada), partes fictícias e uma petição inicial em PDF
 * gerada na hora com a marca "DOCUMENTO FICTÍCIO". Nada é lido do banco.
 */
import "dotenv/config";
import { randomInt, randomUUID } from "node:crypto";
import { computeCnjCheckDigit } from "@/domain/cnj";
import { buildDemoCaseDocuments } from "@/modules/briefs/demo-documents";

const FICTITIOUS_NAMES = [
  "Maria Fictícia de Souza",
  "João Exemplo da Silva",
  "Ana Demonstração Pereira",
  "Carlos Teste Oliveira",
  "Beatriz Simulada Santos",
];

function fictitiousCnj(year: number): string {
  const sequence = String(randomInt(1, 9_999_999)).padStart(7, "0");
  const parts = { sequence, year, segment: "5", tribunal: "10", origin: "9999" };
  const dd = computeCnjCheckDigit(parts);
  return `${sequence}-${dd}.${year}.5.10.9999`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const apiKey = process.env.PRAETOR_API_KEY?.trim();
  const baseUrl = (process.env.PRAETOR_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  if (!apiKey && !dryRun) {
    console.error("Defina PRAETOR_API_KEY (crie a chave em Administração, Integrações, API de entrada).");
    process.exit(1);
  }

  const year = new Date().getFullYear();
  const number = fictitiousCnj(year);
  const plaintiff = FICTITIOUS_NAMES[randomInt(0, FICTITIOUS_NAMES.length)];
  const defendant = "EMPRESA MODELO TESTE LTDA";
  const claimAmountCents = randomInt(1_800_000, 32_000_000);
  const filedAt = new Date().toISOString().slice(0, 10);
  const docs = await buildDemoCaseDocuments({
    number,
    court: "TRT10",
    courtDivision: "Vara do Trabalho Fictícia de Palmas",
    city: "Palmas",
    state: "TO",
    plaintiff,
    defendant,
    processClass: "ATOrd",
    claimAmountCents,
    filedAt,
  });
  const petition = docs[0];

  const body = {
    numero: number,
    tribunal: "TRT10",
    orgaoJulgador: "Vara do Trabalho Fictícia de Palmas",
    cidade: "Palmas",
    uf: "TO",
    classe: "ATOrd",
    area: "labor",
    fase: "knowledge",
    ajuizadoEm: filedAt,
    valorDaCausa: (claimAmountCents / 100).toFixed(2),
    partes: [
      { nome: `${plaintiff} (fictícia)`, polo: "ativo" },
      { nome: defendant, polo: "passivo" },
    ],
    empresaNome: defendant,
    documentos: [
      {
        titulo: `${petition.title} (fictícia)`,
        categoria: petition.category,
        nomeArquivo: petition.fileName,
        conteudoBase64: Buffer.from(petition.bytes).toString("base64"),
      },
    ],
    origem: { sistema: "ERP de demonstração (script demo-api-push)", referencia: `DEMO-${Date.now()}` },
    observacao: "CASO FICTÍCIO enviado pelo script de demonstração da API de entrada. Não corresponde a processo real.",
  };

  console.log(`Processo fictício ${number}: ${plaintiff} x ${defendant}, valor da causa R$ ${body.valorDaCausa}, 1 PDF (${petition.bytes.byteLength} bytes).`);
  if (dryRun) {
    console.log("--dry-run: nada foi enviado.");
    return;
  }

  const idempotencyKey = randomUUID();
  const res = await fetch(`${baseUrl}/api/v1/processos`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);

  const status = await fetch(`${baseUrl}/api/v1/processos/${number.replace(/\D/g, "")}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (status.ok) {
    console.log("Situação logo após o envio:");
    console.log(JSON.stringify(await status.json(), null, 2));
  } else if (status.status === 403) {
    console.log("A chave não tem a permissão process:read: a consulta de situação foi pulada.");
  }
}

main().catch((err) => {
  console.error("Falha ao enviar:", err instanceof Error ? err.message : err);
  process.exit(1);
});
