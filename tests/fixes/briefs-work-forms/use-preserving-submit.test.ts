/**
 * Review fix "briefs-work-forms" (React 19 form reset): the shared
 * `usePreservingSubmit` hook prevents the native submit (so React never resets
 * the form) and dispatches the FormData — with the clicked submitter — itself.
 * The module copies are re-exports of the shared hook.
 */
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { usePreservingSubmit as fromContracts } from "@/modules/contracts/components/use-preserving-submit";
import { usePreservingSubmit as fromDistribution } from "@/modules/distribution/components/use-preserving-submit";
import { usePreservingSubmit as fromOccurrences } from "@/modules/occurrences/components/use-preserving-submit";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePreservingSubmit (@/components/ui/use-preserving-submit)", () => {
  it("is the hook re-exported by the contracts, occurrences and distribution modules", () => {
    expect(fromContracts).toBe(usePreservingSubmit);
    expect(fromOccurrences).toBe(usePreservingSubmit);
    expect(fromDistribution).toBe(usePreservingSubmit);
  });

  it("prevents the native submit and dispatches the form data built with the submitter", () => {
    class FakeFormData {
      constructor(
        readonly form?: unknown,
        readonly submitter?: unknown,
      ) {}
    }
    vi.stubGlobal("FormData", FakeFormData);
    const dispatch = vi.fn();
    let onSubmit: ((event: unknown) => void) | undefined;
    function Probe() {
      onSubmit = usePreservingSubmit(dispatch) as unknown as (event: unknown) => void;
      return null;
    }
    renderToString(h(Probe));

    const form = { tagName: "FORM" };
    const submitter = { name: "decision", value: "validated" };
    const preventDefault = vi.fn();
    onSubmit!({ preventDefault, currentTarget: form, nativeEvent: { submitter } });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const formData = dispatch.mock.calls[0][0] as FakeFormData;
    expect(formData).toBeInstanceOf(FakeFormData);
    expect(formData.form).toBe(form);
    expect(formData.submitter).toBe(submitter);
  });
});
