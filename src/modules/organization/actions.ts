"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { bool, str } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import {
  createCompany,
  createLawFirm,
  deleteCompany,
  deleteLawFirm,
  setCompanyActive,
  setLawFirmActive,
  updateCompany,
  updateLawFirm,
} from "./service";

/**
 * Server actions for companies and external law firms (admin area). Thin
 * wrappers: authenticate, translate FormData, call the service (which validates
 * and authorizes again), revalidate and map errors to pt-BR messages.
 */

type Result<T = undefined> = ActionResult<T>;

async function run<T>(
  action: string,
  fn: (ctx: Awaited<ReturnType<typeof requireActionContext>>) => Promise<Result<T>>,
): Promise<Result<T>> {
  try {
    const ctx = await requireActionContext("admin:organization");
    return await fn(ctx);
  } catch (err) {
    if (!(err instanceof AppError)) logger.error("action_failed", { action, error: err });
    return toActionError(err);
  }
}

const idFrom = (fd: FormData) => str(fd, "id") ?? "";

function companyInput(fd: FormData, withActive: boolean) {
  return {
    name: str(fd, "name") ?? "",
    document: str(fd, "document") ?? null,
    ...(withActive ? { isActive: bool(fd, "isActive") } : {}),
  };
}

function lawFirmInput(fd: FormData, withActive: boolean) {
  return {
    name: str(fd, "name") ?? "",
    document: str(fd, "document") ?? null,
    contactName: str(fd, "contactName") ?? null,
    contactEmail: str(fd, "contactEmail") ?? null,
    ...(withActive ? { isActive: bool(fd, "isActive") } : {}),
  };
}

function revalidate() {
  // Company and law firm names appear in filters and forms across the app.
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function createCompanyAction(_prev: Result<{ id: string }> | null, fd: FormData): Promise<Result<{ id: string }>> {
  const result = await run<{ id: string }>("createCompany", async (ctx) => {
    const created = await createCompany(ctx, companyInput(fd, false));
    revalidate();
    return { ok: true, data: created, message: "Empresa cadastrada." };
  });
  if (result.ok && result.data) redirect(`/admin/empresas/${result.data.id}?criado=1`);
  return result;
}

export async function updateCompanyAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateCompany", async (ctx) => {
    await updateCompany(ctx, idFrom(fd), companyInput(fd, true));
    revalidate();
    return { ok: true, message: "Alterações salvas." };
  });
}

export async function setCompanyActiveAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("setCompanyActive", async (ctx) => {
    const active = str(fd, "active") === "1";
    await setCompanyActive(ctx, idFrom(fd), active);
    revalidate();
    return { ok: true, message: active ? "Empresa reativada." : "Empresa desativada." };
  });
}

export async function deleteCompanyAction(_prev: Result | null, fd: FormData): Promise<Result> {
  let deleted = false;
  const result = await run<undefined>("deleteCompany", async (ctx) => {
    const { outcome } = await deleteCompany(ctx, idFrom(fd));
    revalidate();
    deleted = outcome === "deleted";
    return {
      ok: true,
      message: deleted
        ? "Empresa excluída."
        : "A empresa possui vínculos (processos, importações, fechamentos ou regras) e foi desativada em vez de excluída.",
    };
  });
  if (result.ok && deleted) redirect("/admin/empresas");
  return result;
}

// ---------------------------------------------------------------------------
// Law firms
// ---------------------------------------------------------------------------

export async function createLawFirmAction(_prev: Result<{ id: string }> | null, fd: FormData): Promise<Result<{ id: string }>> {
  const result = await run<{ id: string }>("createLawFirm", async (ctx) => {
    const created = await createLawFirm(ctx, lawFirmInput(fd, false));
    revalidate();
    return { ok: true, data: created, message: "Escritório cadastrado." };
  });
  if (result.ok && result.data) redirect(`/admin/escritorios/${result.data.id}?criado=1`);
  return result;
}

export async function updateLawFirmAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("updateLawFirm", async (ctx) => {
    await updateLawFirm(ctx, idFrom(fd), lawFirmInput(fd, true));
    revalidate();
    return { ok: true, message: "Alterações salvas." };
  });
}

export async function setLawFirmActiveAction(_prev: Result | null, fd: FormData): Promise<Result> {
  return run("setLawFirmActive", async (ctx) => {
    const active = str(fd, "active") === "1";
    await setLawFirmActive(ctx, idFrom(fd), active);
    revalidate();
    return { ok: true, message: active ? "Escritório reativado." : "Escritório desativado." };
  });
}

export async function deleteLawFirmAction(_prev: Result | null, fd: FormData): Promise<Result> {
  let deleted = false;
  const result = await run<undefined>("deleteLawFirm", async (ctx) => {
    const { outcome } = await deleteLawFirm(ctx, idFrom(fd));
    revalidate();
    deleted = outcome === "deleted";
    return {
      ok: true,
      message: deleted
        ? "Escritório excluído."
        : "O escritório possui vínculos (usuários, processos, entradas ou regras) e foi desativado em vez de excluído.",
    };
  });
  if (result.ok && deleted) redirect("/admin/escritorios");
  return result;
}
