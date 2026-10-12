import { describe, expect, it } from "vitest";
import { csvCell, issuesToCsv } from "@/modules/imports/csv";

describe("issues CSV", () => {
  it("uses BOM, ';' and CRLF, quoting only when needed", () => {
    const csv = issuesToCsv([
      { sheet: "Consolidado Geral", rowNumber: 1097, cnj: null, level: "info", code: "total_row", field: null, message: "Linha de totalização — ignorada." },
      {
        sheet: "1º Grau",
        rowNumber: 12,
        cnj: "0000001-11.2024.5.10.0001",
        level: "warning",
        code: "value_divergence",
        field: "Valor da causa",
        message: 'Divergência; "Consolidado" informa R$ 1,00',
      },
    ]);
    const lines = csv.split("\r\n");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(lines[0]).toBe("﻿Aba;Linha;Número do processo;Nível;Tipo;Campo;Descrição");
    expect(lines[1]).toBe("Consolidado Geral;1097;;Informação;Linha de total ignorada;;Linha de totalização — ignorada.");
    expect(lines[2]).toBe(
      '1º Grau;12;0000001-11.2024.5.10.0001;Alerta;Divergência entre abas;Valor da causa;"Divergência; ""Consolidado"" informa R$ 1,00"',
    );
    expect(lines[3]).toBe("");
  });

  it("neutralizes spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+55")).toBe("'+55");
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });
});
