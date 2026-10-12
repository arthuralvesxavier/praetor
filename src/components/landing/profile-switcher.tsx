"use client";

import { Briefcase, Building2, Calculator, Check, ClipboardCheck, Scale, X, type LucideIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * "Perfis" section of the landing page: what each profile sees and does.
 * Mirrors ROLE_PERMISSIONS (src/server/auth/permissions.ts) and the row rules
 * in src/server/auth/access.ts — keep both in sync when roles change.
 */
const PROFILES: {
  key: string;
  label: string;
  icon: LucideIcon;
  who: string;
  sees: string[];
  does: string[];
  doesNot: string[];
}[] = [
  {
    key: "juridico",
    label: "Jurídico",
    icon: Scale,
    who: "Gestor jurídico, advogados e analistas",
    sees: [
      "Gestor: toda a carteira, inclusive processos sigilosos",
      "Advogados e analistas: a própria unidade e os casos sob sua responsabilidade",
    ],
    does: [
      "Registra a entrada de processos; o gestor configura a distribuição aos responsáveis",
      "Revisa, edita e aprova a análise preliminar (simulada nesta versão)",
      "Cuida de prazos, audiências, acordos, documentos e valores",
    ],
    doesNot: ["Advogados e analistas não veem registros sigilosos de outras unidades"],
  },
  {
    key: "diretoria",
    label: "Diretoria",
    icon: Briefcase,
    who: "Diretoria e executivos",
    sees: ["Painel executivo, relatórios e inteligência preventiva", "Carteira não sigilosa da organização"],
    does: ["Acompanha exposição, provisão e tendências por empresa, tribunal e fase", "Exporta relatórios"],
    doesNot: ["Não edita registros", "Não acessa processos sigilosos"],
  },
  {
    key: "contabilidade",
    label: "Contabilidade",
    icon: Calculator,
    who: "Contabilidade e controladoria",
    sees: ["Valores, garantias, acordos, risco e provisão da carteira não sigilosa"],
    does: [
      "Confere e oficializa valores propostos, com o nome de quem conferiu",
      "Fecha a competência mensal — o fechamento não muda depois",
      "Exporta relatórios de provisão em XLSX e CSV",
    ],
    doesNot: ["Não acessa peças sigilosas nem documentos de saúde"],
  },
  {
    key: "auditoria",
    label: "Auditoria",
    icon: ClipboardCheck,
    who: "Auditoria e compliance",
    sees: [
      "Carteira não sigilosa, relatórios e trilha de auditoria",
      "Análises preliminares e e-mails simulados, para conferência",
    ],
    does: ["Consulta quem alterou o quê e quando", "Confere fechamentos mensais e relatórios"],
    doesNot: ["Não altera registros"],
  },
  {
    key: "escritorio",
    label: "Escritório externo",
    icon: Building2,
    who: "Escritórios de advocacia parceiros",
    sees: ["Somente os processos atribuídos ao próprio escritório"],
    does: [
      "Atualiza processos, documentos, prazos e tarefas da sua carteira",
      "Lança valores para conferência e revisa análises preliminares",
    ],
    doesNot: ["Não vê processos de outros escritórios", "Não oficializa valores nem fecha competências"],
  },
];

export function ProfileSwitcher() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const profile = PROFILES[active];
  const Icon = profile.icon;

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (active + 1) % PROFILES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (active - 1 + PROFILES.length) % PROFILES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = PROFILES.length - 1;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-10">
      <div
        role="tablist"
        aria-label="Perfis de acesso"
        aria-orientation="vertical"
        onKeyDown={onKey}
        className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
      >
        {PROFILES.map((p, i) => {
          const TabIcon = p.icon;
          const selected = i === active;
          return (
            <button
              key={p.key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`perfil-tab-${p.key}`}
              aria-selected={selected}
              aria-controls={`perfil-painel-${p.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(i)}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-semibold transition-colors",
                selected
                  ? "border-navy-900 bg-navy-900 text-white shadow-lg shadow-navy-900/15"
                  : "border-slate-200 bg-white text-slate-700 hover:border-gold-400 hover:text-slate-900",
              )}
            >
              <TabIcon aria-hidden="true" className={cn("size-4", selected ? "text-gold-400" : "text-navy-600")} />
              {p.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`perfil-painel-${profile.key}`}
        aria-labelledby={`perfil-tab-${profile.key}`}
        className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8"
      >
        <div key={profile.key} className="motion-safe:animate-fade-up">
          <div className="flex items-center gap-3">
            <span className="inline-flex size-11 items-center justify-center rounded-xl bg-navy-900 text-gold-400">
              <Icon aria-hidden="true" className="size-5" />
            </span>
            <div>
              <h3 className="font-display text-3xl leading-none font-semibold text-slate-900">{profile.label}</h3>
              <p className="mt-1 text-sm text-slate-600">{profile.who}</p>
            </div>
          </div>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div>
              <p className="text-xs font-semibold tracking-[0.14em] text-gold-700 uppercase">O que vê</p>
              <ul className="mt-3 space-y-2.5">
                {profile.sees.map((t) => (
                  <li key={t} className="flex gap-2.5 text-sm text-slate-700">
                    <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-700" />
                    {t}
                  </li>
                ))}
              </ul>
              <p className="mt-6 text-xs font-semibold tracking-[0.14em] text-gold-700 uppercase">Limites</p>
              <ul className="mt-3 space-y-2.5">
                {profile.doesNot.map((t) => (
                  <li key={t} className="flex gap-2.5 text-sm text-slate-700">
                    <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-red-700" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-[0.14em] text-gold-700 uppercase">O que faz</p>
              <ul className="mt-3 space-y-2.5">
                {profile.does.map((t) => (
                  <li key={t} className="flex gap-2.5 text-sm text-slate-700">
                    <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-gold-500" />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
