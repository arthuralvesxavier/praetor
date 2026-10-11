import { describe, expect, it } from "vitest";
import { asciiFileName, attachmentDisposition } from "@/modules/documents/content-disposition";
import { extensionOf, isAllowedExtension, maxUploadBytes, UPLOAD_ACCEPT } from "@/modules/documents/file-types";
import {
  detectFileType,
  sanitizeFileName,
  sha256Hex,
  validateUploadFile,
  zipEntryNames,
} from "@/modules/documents/validation";
import { ValidationError } from "@/server/lib/errors";
import { buildDocx, buildPdf, buildZip, JPEG_BYTES, PNG_BYTES, utf8 } from "./fixtures";

const MB = 1024 * 1024;
const opts = { maxBytes: 5 * MB };

function rejection(name: string, bytes: Uint8Array, o = opts): string {
  try {
    validateUploadFile({ name, bytes }, o);
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    const e = err as ValidationError;
    expect(e.fieldErrors?.file?.[0]).toBe(e.message);
    return e.message;
  }
  throw new Error(`expected ${name} to be rejected`);
}

describe("detectFileType (magic bytes)", () => {
  it("detects the allowed formats", () => {
    expect(detectFileType(buildPdf("ola"))).toBe("pdf");
    expect(detectFileType(buildDocx("ola"))).toBe("docx");
    expect(detectFileType(PNG_BYTES)).toBe("png");
    expect(detectFileType(JPEG_BYTES)).toBe("jpeg");
    expect(detectFileType(utf8("Contrato de prestação de serviços\nCláusula 1ª"))).toBe("text");
    expect(detectFileType(utf8("# Título\n\n- item"))).toBe("text");
    expect(detectFileType(utf8("\ufeffnome;valor\nA;1"))).toBe("text");
  });

  it("rejects plain ZIPs, legacy Office, executables and binary data", () => {
    expect(detectFileType(buildZip([{ name: "a.txt", data: "x" }]))).toBeNull();
    // A ZIP with Word entries but without [Content_Types].xml is not a DOCX.
    expect(detectFileType(buildZip([{ name: "word/document.xml", data: "<x/>" }]))).toBeNull();
    // Macro-enabled content disguised as .docx.
    expect(
      detectFileType(
        buildZip([
          { name: "[Content_Types].xml", data: "<Types/>" },
          { name: "word/document.xml", data: "<x/>" },
          { name: "word/vbaProject.bin", data: "x" },
        ]),
      ),
    ).toBeNull();
    expect(detectFileType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toBeNull();
    expect(detectFileType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]))).toBeNull(); // MZ
    expect(detectFileType(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]))).toBeNull(); // ELF
    expect(detectFileType(new Uint8Array([0xc3, 0x28, 0x41]))).toBeNull(); // invalid UTF-8
    expect(detectFileType(utf8("abc\u0000def"))).toBeNull(); // NUL byte
    expect(detectFileType(new Uint8Array())).toBeNull();
  });

  it("rejects HTML, SVG and XML even as text", () => {
    expect(detectFileType(utf8("<!DOCTYPE html><html><body>x</body></html>"))).toBeNull();
    expect(detectFileType(utf8("  <html><script>alert(1)</script></html>"))).toBeNull();
    expect(detectFileType(utf8('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
    expect(detectFileType(utf8('<?xml version="1.0"?><svg/>'))).toBeNull();
  });

  it("reads ZIP central directory names", () => {
    expect(zipEntryNames(buildZip([{ name: "a", data: "1" }, { name: "b/c", data: "2" }]))).toEqual(["a", "b/c"]);
    expect(zipEntryNames(utf8("PK\u0003\u0004 truncated"))).toBeNull();
  });
});

describe("validateUploadFile", () => {
  it("accepts matching extension and content, deriving the MIME type from content", () => {
    const pdf = validateUploadFile({ name: "Petição inicial.PDF", bytes: buildPdf("x") }, opts);
    expect(pdf).toMatchObject({ kind: "pdf", mimeType: "application/pdf", extension: "pdf", fileName: "Petição inicial.pdf" });
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateUploadFile({ name: "c.docx", bytes: buildDocx("x") }, opts).mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(validateUploadFile({ name: "foto.jpeg", bytes: JPEG_BYTES }, opts).mimeType).toBe("image/jpeg");
    expect(validateUploadFile({ name: "foto.jpg", bytes: JPEG_BYTES }, opts).kind).toBe("jpeg");
    expect(validateUploadFile({ name: "img.png", bytes: PNG_BYTES }, opts).mimeType).toBe("image/png");
    expect(validateUploadFile({ name: "notas.md", bytes: utf8("# a") }, opts).mimeType).toBe("text/markdown");
    expect(validateUploadFile({ name: "dados.csv", bytes: utf8("a;b") }, opts).mimeType).toBe("text/csv");
    expect(validateUploadFile({ name: "leia.txt", bytes: utf8("olá") }, opts).mimeType).toBe("text/plain");
  });

  it("rejects extension/content mismatches", () => {
    expect(rejection("contrato.pdf", utf8("não é um pdf"))).toContain("não corresponde à extensão .pdf");
    expect(rejection("foto.png", JPEG_BYTES)).toContain(".png");
    expect(rejection("texto.txt", buildPdf("x"))).toContain(".txt");
    expect(rejection("planilha.docx", buildZip([{ name: "a", data: "b" }]))).toContain("formato permitido");
  });

  it("rejects disallowed formats with pt-BR messages", () => {
    expect(rejection("pagina.html", utf8("<html></html>"))).toContain("Formato .html não permitido");
    expect(rejection("logo.svg", utf8("<svg/>"))).toContain("Formato .svg não permitido");
    expect(rejection("disfarcado.txt", utf8("<!doctype html><p>x</p>"))).toContain("formato permitido");
    expect(rejection("app.exe", new Uint8Array([0x4d, 0x5a]))).toContain(".exe");
    expect(rejection("pacote.zip", buildZip([{ name: "a", data: "b" }]))).toContain(".zip");
    expect(rejection("antigo.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toContain(".docx ou PDF");
    expect(rejection("sem-extensao", utf8("abc"))).toContain("extensão permitida");
  });

  it("enforces the size limit and rejects empty files", () => {
    expect(rejection("vazio.txt", new Uint8Array())).toBe("O arquivo está vazio.");
    expect(rejection("grande.txt", new Uint8Array(1025).fill(0x61), { maxBytes: 1024 })).toContain("excede o limite");
    expect(validateUploadFile({ name: "ok.txt", bytes: new Uint8Array(1024).fill(0x61) }, { maxBytes: 1024 }).sizeBytes).toBe(1024);
  });
});

describe("sanitizeFileName", () => {
  it("strips paths, control and bidi characters", () => {
    expect(sanitizeFileName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeFileName("C:\\Users\\x\\Relatório final.pdf")).toBe("Relatório final.pdf");
    expect(sanitizeFileName("a\u0000b\u0007c.txt")).toBe("abc.txt");
    expect(sanitizeFileName("fatura\u202Etxt.exe")).toBe("faturatxt.exe");
    expect(sanitizeFileName('nome<>:"|?*.pdf')).toBe("nome_______.pdf");
    expect(sanitizeFileName("  muitos   espaços  .pdf ")).toBe("muitos espaços.pdf");
  });

  it("never returns an empty or dot name and limits the length keeping the extension", () => {
    expect(sanitizeFileName("")).toBe("documento");
    // A leading dot is dropped (hidden-file names); the result then has no extension and is rejected later.
    expect(sanitizeFileName(".pdf")).toBe("pdf");
    expect(sanitizeFileName("...")).toBe("documento");
    const long = sanitizeFileName(`${"a".repeat(500)}.docx`);
    expect(long.length).toBe(180);
    expect(long.endsWith(".docx")).toBe(true);
  });
});

describe("helpers", () => {
  it("file-types are consistent", () => {
    expect(extensionOf("a.b.PDF")).toBe("pdf");
    expect(extensionOf("semext")).toBe("");
    expect(extensionOf(".bashrc")).toBe("");
    expect(isAllowedExtension("x.JPG")).toBe(true);
    expect(isAllowedExtension("x.svg")).toBe(false);
    expect(UPLOAD_ACCEPT).toContain(".docx");
    expect(maxUploadBytes(20)).toBe(20 * MB);
  });

  it("sha256Hex matches a known vector", () => {
    expect(sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("builds a safe Content-Disposition header", () => {
    expect(asciiFileName('Relatório "final"\r\n.pdf')).toBe("Relatorio _final_.pdf");
    const header = attachmentDisposition("Petição nº 1.pdf");
    expect(header).toBe(`attachment; filename="Peticao n_ 1.pdf"; filename*=UTF-8''Peti%C3%A7%C3%A3o%20n%C2%BA%201.pdf`);
    expect(header).not.toMatch(/[\r\n]/);
  });
});
