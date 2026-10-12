import { cnjDigits, isValidCnj, parseCnj } from "@/domain/cnj";

/**
 * DataJud endpoint aliases derived from the CNJ number (Resolução CNJ 65/2008:
 * J = segment, TR = tribunal). Official list:
 * https://datajud-wiki.cnj.jus.br/api-publica/endpoints
 *
 *   J = 5 (Justiça do Trabalho): TR 01..24 -> trt<TR>, plus tst (the same
 *         number is indexed by the TST when the case reaches it); TR 00 -> tst.
 *   J = 8 (Justiça Estadual): TR -> tj<UF> (tjdft for the Distrito Federal).
 *   J = 4 (Justiça Federal): TR 01..06 -> trf<TR>.
 *   Any other segment: unsupported (no guessing).
 *
 * A number whose check digit (módulo 97) does not match cannot exist in the
 * DataJud: it is reported as invalid and never queried.
 */

/** TR code of the state courts (J = 8), in the CNJ order. */
const STATE_COURTS: Readonly<Record<string, string>> = {
  "01": "tjac",
  "02": "tjal",
  "03": "tjap",
  "04": "tjam",
  "05": "tjba",
  "06": "tjce",
  "07": "tjdft",
  "08": "tjes",
  "09": "tjgo",
  "10": "tjma",
  "11": "tjmt",
  "12": "tjms",
  "13": "tjmg",
  "14": "tjpa",
  "15": "tjpb",
  "16": "tjpr",
  "17": "tjpe",
  "18": "tjpi",
  "19": "tjrj",
  "20": "tjrn",
  "21": "tjrs",
  "22": "tjro",
  "23": "tjrr",
  "24": "tjsc",
  "25": "tjse",
  "26": "tjsp",
  "27": "tjto",
};

export type CourtAliases =
  | {
      supported: true;
      /** 20 digits (the DataJud `numeroProcesso`). */
      digits: string;
      /** Endpoint of the tribunal of origin (the one that "owns" the process). */
      primary: string;
      /** Other endpoints queried with the same number (e.g. "tst" for labor cases). */
      secondary: string[];
    }
  | { supported: false; reason: UnsupportedReason };

export type UnsupportedReason = "invalid_number" | "invalid_check_digit" | "unsupported_segment" | "unknown_tribunal";

/**
 * Endpoints of a CNJ number. `allowInvalidCheckDigit` only serves to SUGGEST
 * the court acronym of a number typed with a wrong check digit (it is never
 * used to query the DataJud).
 */
export function courtAliasesForCnj(value: string | null | undefined, opts: { allowInvalidCheckDigit?: boolean } = {}): CourtAliases {
  const parts = parseCnj(value);
  if (!parts) return { supported: false, reason: "invalid_number" };
  if (!opts.allowInvalidCheckDigit && !isValidCnj(value)) return { supported: false, reason: "invalid_check_digit" };
  const digits = cnjDigits(value ?? "");
  const tr = Number(parts.tribunal);
  if (parts.segment === "5") {
    if (parts.tribunal === "00") return { supported: true, digits, primary: "tst", secondary: [] };
    if (tr >= 1 && tr <= 24) return { supported: true, digits, primary: `trt${tr}`, secondary: ["tst"] };
    return { supported: false, reason: "unknown_tribunal" };
  }
  if (parts.segment === "8") {
    const alias = STATE_COURTS[parts.tribunal];
    return alias ? { supported: true, digits, primary: alias, secondary: [] } : { supported: false, reason: "unknown_tribunal" };
  }
  if (parts.segment === "4") {
    if (tr >= 1 && tr <= 6) return { supported: true, digits, primary: `trf${tr}`, secondary: [] };
    return { supported: false, reason: "unknown_tribunal" };
  }
  return { supported: false, reason: "unsupported_segment" };
}

/** Acronym shown for an alias ("trt10" -> "TRT10", "tjdft" -> "TJDFT"). */
export function aliasLabel(alias: string): string {
  return alias.toUpperCase();
}

export const UNSUPPORTED_REASON_LABELS: Record<UnsupportedReason, string> = {
  invalid_number: "O número não está no padrão CNJ (20 dígitos).",
  invalid_check_digit:
    "O dígito verificador do número CNJ não confere: o número não existe no DataJud. Corrija o cadastro para ativar a consulta.",
  unsupported_segment:
    "O segmento de Justiça deste número não tem consulta automática nesta versão (só Trabalho, Estadual e Federal).",
  unknown_tribunal: "O código do tribunal no número não corresponde a um endpoint do DataJud.",
};
