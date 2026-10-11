/**
 * Demo environment accounts created by `npm run db:seed`. Shown on the login
 * page only while a demo organization exists. All data in demo organizations
 * is fictional.
 */
export const DEMO_PASSWORD = "Praetor@2026";

export const DEMO_ACCOUNTS = [
  { email: "admin@demo.praetor.local", name: "Helena Duarte", role: "admin", description: "Administradora" },
  { email: "gestor@demo.praetor.local", name: "Ricardo Menezes", role: "legal_manager", description: "Gestor jurídico" },
  { email: "advogada@demo.praetor.local", name: "Camila Rocha", role: "lawyer", description: "Advogada — Matriz São Paulo" },
  { email: "advogado.recife@demo.praetor.local", name: "Tiago Albuquerque", role: "lawyer", description: "Advogado — Filial Recife" },
  { email: "analista@demo.praetor.local", name: "Bruna Lima", role: "analyst", description: "Analista — Matriz São Paulo" },
  { email: "executivo@demo.praetor.local", name: "Paulo Siqueira", role: "executive", description: "Diretor executivo (somente consulta)" },
  { email: "admin@outra.praetor.local", name: "Marta Nogueira", role: "admin", description: "Administradora de outra organização (teste de isolamento)" },
] as const;
