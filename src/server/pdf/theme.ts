import { rgb, type RGB } from "pdf-lib";

/** "#RRGGBB" → cor do pdf-lib. */
export function hex(value: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
  if (!m) throw new Error(`Cor inválida: ${value}`);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

/** Cores da marca (navy #0B1A2C, dourado #D4B062) e neutros do sistema. */
export const COLORS = {
  navy: hex("#0B1A2C"),
  navySoft: hex("#22324A"),
  gold: hex("#D4B062"),
  goldText: hex("#7F6227"),
  goldWash: hex("#FBF6EA"),
  ink: hex("#0F172A"),
  body: hex("#1E293B"),
  secondary: hex("#475569"),
  muted: hex("#64748B"),
  subtle: hex("#94A3B8"),
  rule: hex("#E2E8F0"),
  ruleStrong: hex("#CBD5E1"),
  zebra: hex("#F6F7F9"),
  panel: hex("#F5F6F8"),
  infoBg: hex("#EEF2F7"),
  infoBar: hex("#22324A"),
  warnBg: hex("#FDF6E3"),
  warnBar: hex("#B7791F"),
  white: rgb(1, 1, 1),
};

/** Selos de origem: cor E texto (a cor nunca é o único sinal). */
export const SEAL_KINDS = ["documented", "record", "inference", "analysis", "gap"] as const;
export type SealKind = (typeof SEAL_KINDS)[number];

export const SEAL_STYLES: Record<SealKind, { fg: RGB; bg: RGB; border: RGB }> = {
  documented: { fg: hex("#14532D"), bg: hex("#DCFCE7"), border: hex("#86C99E") },
  record: { fg: hex("#1E3A8A"), bg: hex("#DBEAFE"), border: hex("#8DB4EA") },
  inference: { fg: hex("#78350F"), bg: hex("#FEF3C7"), border: hex("#E3BC5A") },
  analysis: { fg: hex("#4C1D95"), bg: hex("#EDE9FE"), border: hex("#B5A4E8") },
  gap: { fg: hex("#7F1D1D"), bg: hex("#FEE2E2"), border: hex("#E49A9A") },
};

/** A4 em pontos e áreas da página. */
export const PAGE = {
  width: 595.28,
  height: 841.89,
  marginX: 56.7,
  /** Topo da área de conteúdo (abaixo do cabeçalho). */
  contentTop: 841.89 - 88,
  /** Base da área de conteúdo (acima do rodapé). */
  contentBottom: 74,
} as const;

export const CONTENT_WIDTH = PAGE.width - 2 * PAGE.marginX;
