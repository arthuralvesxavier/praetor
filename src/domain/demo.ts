/**
 * Demo environment accounts. Shown on the login page only while a demo
 * organization exists. All data in demo organizations is fictional.
 *
 * - The first seven accounts are created by `npm run db:seed`.
 * - The v2 accounts (accounting, audit, external law firm and the regional
 *   lawyers of the fictitious spreadsheet portfolio) are created by
 *   `npm run db:seed:v2`, which `npm run db:setup` also runs.
 */
export const DEMO_PASSWORD = "Praetor@2026";

export const DEMO_ACCOUNTS = [
  { email: "admin@demo.praetor.local", name: "Helena Duarte", role: "admin", description: "Administradora" },
  { email: "gestor@demo.praetor.local", name: "Ricardo Menezes", role: "legal_manager", description: "Gestor jurídico" },
  { email: "advogada@demo.praetor.local", name: "Camila Rocha", role: "lawyer", description: "Advogada, Matriz São Paulo" },
  { email: "advogado.recife@demo.praetor.local", name: "Tiago Albuquerque", role: "lawyer", description: "Advogado, Filial Recife" },
  { email: "analista@demo.praetor.local", name: "Bruna Lima", role: "analyst", description: "Analista, Matriz São Paulo" },
  { email: "executivo@demo.praetor.local", name: "Paulo Siqueira", role: "executive", description: "Diretor executivo (somente consulta)" },
  { email: "admin@outra.praetor.local", name: "Marta Nogueira", role: "admin", description: "Administradora de outra organização (teste de isolamento)" },
  // v2 (npm run db:seed:v2)
  { email: "contabilidade@demo.praetor.local", name: "Sérgio Valadares", role: "accountant", description: "Contabilidade: provisão e fechamento mensal" },
  { email: "auditoria@demo.praetor.local", name: "Lúcia Fontes", role: "auditor", description: "Auditoria e compliance (somente consulta)" },
  { email: "escritorio@demo.praetor.local", name: "Marcelo Antunes", role: "external_counsel", description: "Escritório externo: Escritório Parceiro Exemplo Advogados (fictício)" },
  { email: "advogada.palmas@demo.praetor.local", name: "Larissa Tavares", role: "lawyer", description: "Advogada, Regional Centro-Norte (fictícia)" },
  { email: "advogado.brasilia@demo.praetor.local", name: "Diego Montenegro", role: "lawyer", description: "Advogado, Regional Centro-Norte (fictícia)" },
] as const;
