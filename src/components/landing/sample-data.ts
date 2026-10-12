import { computeCnjCheckDigit } from "@/domain/cnj";

/**
 * Illustrative data shown in the landing page mockups (product preview and the
 * "Como funciona" screens). Everything here is fictitious and labeled
 * "Dados ilustrativos" on screen; nothing is read from the database.
 *
 * CNJ numbers are built with the real check digit (module 97), so they pass
 * the same validation the import applies. The figures are consistent with each
 * other: the portfolio totals are the sums of the rows below.
 */

/** NNNNNNN-DD.AAAA.J.TR.OOOO with the computed check digit. */
export function sampleCnj(sequence: string, year: number, segment: string, tribunal: string, origin: string): string {
  const dd = computeCnjCheckDigit({ sequence, year, segment, tribunal, origin });
  return `${sequence}-${dd}.${year}.${segment}.${tribunal}.${origin}`;
}

export type SampleProcess = {
  number: string;
  title: string;
  plaintiff: string;
  defendant: string;
  court: string;
  instance: string;
  phase: string;
  /** Formatted amount, or null when not informed. */
  claim: string | null;
  /** Formatted amount, or null when not assessed ("Não apurado"). */
  liquidated: string | null;
};

const COMPANY = "Empresa Exemplo Ltda";

export const SAMPLE = {
  /** Labor case in the knowledge phase: the "Processo" tab. */
  overtime: {
    number: sampleCnj("0000418", 2025, "5", "10", "0002"),
    title: "Reclamação trabalhista: horas extras",
    plaintiff: "Ana Paula Ribeiro",
    defendant: COMPANY,
    court: "TRT10",
    instance: "1º grau",
    phase: "Conhecimento",
    claim: "R$ 85.000,00",
    liquidated: null,
  },
  appeal: {
    number: sampleCnj("0001127", 2024, "5", "05", "0021"),
    title: "Reclamação trabalhista: verbas rescisórias",
    plaintiff: "Marcos Vieira",
    defendant: COMPANY,
    court: "TRT5",
    instance: "2º grau",
    phase: "Execução / cumprimento",
    claim: "R$ 120.000,00",
    liquidated: "R$ 64.380,12",
  },
  civil: {
    number: sampleCnj("1004512", 2023, "8", "26", "0100"),
    title: "Indenização por danos materiais",
    plaintiff: "Juliana Prado",
    defendant: "Comercial Exemplo S.A.",
    court: "TJSP",
    instance: "1º grau",
    phase: "Conhecimento",
    claim: "R$ 40.000,00",
    liquidated: null,
  },
  liquidation: {
    number: sampleCnj("0000877", 2023, "5", "02", "0035"),
    title: "Reclamação trabalhista: adicional de insalubridade",
    plaintiff: "Ricardo Alves",
    defendant: COMPANY,
    court: "TRT2",
    instance: "1º grau",
    phase: "Liquidação",
    claim: "R$ 210.000,00",
    liquidated: "R$ 97.450,00",
  },
  /** The new case of the "Entrada" tab and of the "Como funciona" steps. */
  incoming: {
    number: sampleCnj("0010233", 2026, "5", "10", "0011"),
    title: "Reclamação trabalhista: equiparação salarial",
    plaintiff: "Fernanda Lopes",
    defendant: COMPANY,
    court: "TRT10",
    instance: "1º grau",
    phase: "Conhecimento",
    claim: "R$ 58.000,00",
    liquidated: null,
  },
} satisfies Record<string, SampleProcess>;

/** Rows of the portfolio table, in the order shown. */
export const SAMPLE_PORTFOLIO: SampleProcess[] = [
  SAMPLE.incoming,
  SAMPLE.overtime,
  SAMPLE.appeal,
  SAMPLE.liquidation,
  SAMPLE.civil,
];

/** Sums of SAMPLE_PORTFOLIO (claim and liquidated are never added together). */
export const SAMPLE_TOTALS = {
  processes: 5,
  claim: "R$ 513.000,00",
  claimCompact: "R$ 513 mil",
  liquidated: "R$ 161.830,12",
  liquidatedCompact: "R$ 161,8 mil",
  assessed: 2,
  notAssessed: 3,
};

/** Fictitious people. */
export const SAMPLE_LAWYER = "Camila Rocha";
export const SAMPLE_LAWYER_FIRST = "Camila";
