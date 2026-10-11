import type { ProcessSeed } from "./aurora";

/**
 * Second demo organization, used only to demonstrate tenant isolation: nothing
 * here may ever appear to users of the Grupo Aurora organization (and
 * vice versa). Same fictional-data rules as aurora.ts.
 */

export const OUTRA_ORG = {
  name: "Outra Empresa Ltda. (teste de isolamento)",
  slug: "outra-empresa-demo",
};

export const OUTRA_ADMIN_EMAIL = "admin@outra.praetor.local";
export const OUTRA_UNIT = { name: "Sede — Belo Horizonte", code: "BH" };

type OutraProcess = Omit<ProcessSeed, "key" | "createdBy" | "unit" | "responsible" | "fromOccurrence">;

export const OUTRA_PROCESSES: OutraProcess[] = [
  {
    number: "0009001-00.2025.5.03.0000",
    title: "Reclamação trabalhista — Outra Empresa (isolamento)",
    court: "TRT-3 (Minas Gerais)",
    courtDivision: "Vara do Trabalho fictícia nº 2",
    jurisdiction: "Belo Horizonte/MG",
    area: "labor",
    phase: "knowledge",
    status: "active",
    claim: 54000,
    provision: 15000,
    riskLevel: "medium",
    lossProbability: "possible",
    riskRationale: "Registro de outra organização, usado para testar o isolamento.",
    filedAt: -80,
    description: "Processo da Outra Empresa Ltda. Não deve aparecer para o Grupo Aurora. (dados fictícios)",
    parties: [
      { name: "Reclamante Exemplo Mineiro", role: "plaintiff" },
      { name: "Outra Empresa Ltda.", role: "defendant", isClient: true },
    ],
    events: [
      { days: -80, type: "filing", title: "Distribuição da reclamação trabalhista" },
      { days: -30, type: "hearing", title: "Audiência inicial sem acordo" },
    ],
  },
  {
    number: "0009002-00.2025.8.13.0000",
    title: "Ação de cobrança — Outra Empresa (isolamento)",
    court: "TJMG",
    courtDivision: "Vara Cível fictícia nº 1",
    jurisdiction: "Belo Horizonte/MG",
    area: "civil",
    phase: "knowledge",
    status: "active",
    claim: 120000,
    provision: null,
    riskLevel: "low",
    lossProbability: "remote",
    riskRationale: "Registro de outra organização, usado para testar o isolamento.",
    filedAt: -45,
    description: "Cobrança movida pela Outra Empresa Ltda. Não deve aparecer para o Grupo Aurora. (dados fictícios)",
    parties: [
      { name: "Outra Empresa Ltda.", role: "plaintiff", isClient: true },
      { name: "Devedora Exemplo Ltda.", role: "defendant" },
    ],
    events: [{ days: -45, type: "filing", title: "Distribuição da ação de cobrança" }],
  },
];

export const OUTRA_OCCURRENCE = {
  title: "Reclamação de vizinhos sobre ruído na sede (isolamento)",
  facts:
    "Vizinhos da sede reclamaram de ruído de equipamentos de ar-condicionado no período noturno. Registro da Outra Empresa Ltda., usado para testar o isolamento entre organizações. (dados fictícios)",
  category: "regulatory" as const,
  status: "under_analysis" as const,
  riskLevel: "low" as const,
  areasInvolved: ["Facilities"],
  missingInformation: ["Medição de ruído por empresa especializada"],
  occurredOn: -10,
  reportedOn: -9,
};

export const OUTRA_DOCUMENT = {
  file: "comunicado-outra-empresa.txt",
  title: "Comunicado interno — Outra Empresa (isolamento)",
  description: "Documento de outra organização, usado para testar o isolamento.",
};
