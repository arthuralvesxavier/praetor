/**
 * Review fix "briefs-work-forms" (form reset on error, link field): server
 * render of the forms with the shared `usePreservingSubmit` hook mocked, to
 * check that ConfirmDialog and ManualAssignForm wire it to their action, and
 * that the deadline/task "Vínculo" field renders the link type + search field
 * instead of a truncated process select. (No DOM in this suite: the submit
 * behaviour of the hook itself is covered by use-preserving-submit.test.ts.)
 */
import { createElement as h, Fragment, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const preserving = vi.hoisted(() => ({ dispatchers: [] as unknown[] }));

vi.mock("@/components/ui/use-preserving-submit", () => ({
  usePreservingSubmit: (dispatch: unknown) => {
    preserving.dispatchers.push(dispatch);
    return () => {};
  },
}));

vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => h(Fragment, null, children);
  return {
    Dialog: pass,
    DialogTrigger: pass,
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogDescription: pass,
    DialogFooter: pass,
    DialogClose: pass,
  };
});

vi.mock("@/modules/work/actions", () => {
  const fn = async () => ({ ok: true, data: [] });
  return { searchWorkLinkProcessesAction: fn, createDeadlineAction: fn, createTaskAction: fn };
});

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ManualAssignForm } from "@/modules/distribution/components/manual-assign-form";
import { DeadlineForm } from "@/modules/work/components/deadline-form";
import { LinkField } from "@/modules/work/components/link-field";
import { TaskForm } from "@/modules/work/components/task-form";

beforeEach(() => {
  preserving.dispatchers.length = 0;
});

const failing = async () => ({ ok: false as const, error: "Erro de teste." });

describe("forms keep what was typed on an error result", () => {
  it("ConfirmDialog submits through usePreservingSubmit and still renders hidden fields and children", () => {
    const html = renderToString(
      h(ConfirmDialog, {
        action: failing,
        title: "Rejeitar a análise preliminar?",
        hiddenFields: { briefId: "b-1" },
        confirmLabel: "Rejeitar análise",
        children: h("textarea", { name: "reason", required: true, minLength: 3 }),
      }),
    );
    expect(preserving.dispatchers).toHaveLength(1);
    expect(typeof preserving.dispatchers[0]).toBe("function");
    expect(html).toContain('name="briefId"');
    expect(html).toContain('name="reason"');
    expect(html).toContain("Rejeitar análise");
  });

  it("ManualAssignForm submits through usePreservingSubmit (responsible and reason survive an error)", () => {
    const html = renderToString(
      h(ManualAssignForm, {
        action: failing,
        hiddenFields: { intakeId: "i-1" },
        users: [{ value: "u-1", label: "Advogada Fictícia" }],
      }),
    );
    expect(preserving.dispatchers).toHaveLength(1);
    expect(typeof preserving.dispatchers[0]).toBe("function");
    expect(html).toContain('name="userId"');
    expect(html).toContain('name="reason"');
    expect(html).toContain('name="intakeId"');
  });
});

describe("Vínculo of the deadline/task forms", () => {
  const options = {
    processes: [{ id: "p-1", label: "0000001-11.2026.5.10.0001 — Processo fictício" }],
    occurrences: [{ id: "o-1", label: "Ocorrência fictícia" }],
    contracts: [],
    processSearch: true,
  };

  it("renders the link type (process search, occurrence) and submits no link by default", () => {
    const html = renderToString(h(LinkField, { id: "vinculo", options }));
    expect(html).toContain('id="vinculo"');
    expect(html).toContain("Sem vínculo");
    expect(html).toContain('value="legal_process"');
    expect(html).toContain("Ocorrência (preventivo)");
    expect(html).not.toContain('value="contract"');
    expect(html).toMatch(/<input type="hidden" name="link" value=""\/?>/);
    // No process select with a cut list: processes are searched after choosing "Processo".
    expect(html).not.toContain("legal_process:p-1");
  });

  it("is the Vínculo field of the deadline and task forms on /prazos", () => {
    for (const html of [
      renderToString(h(DeadlineForm, { userOptions: [], linkOptions: options })),
      renderToString(h(TaskForm, { userOptions: [], linkOptions: options })),
    ]) {
      expect(html).toContain("Vínculo");
      expect(html).toContain('value="legal_process"');
      expect(html).not.toContain("legal_process:p-1");
    }
  });
});
