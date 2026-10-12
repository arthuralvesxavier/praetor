"use client";

import { RefreshCw } from "lucide-react";
import { ActionButtonForm } from "@/modules/admin/components/form-utils";
import { refreshIndexSeriesNowAction } from "../actions";

/** "Atualizar agora": fetches the missing months of every series immediately (`admin:organization`). */
export function RefreshIndexSeriesButton() {
  return (
    <ActionButtonForm
      action={refreshIndexSeriesNowAction}
      pendingLabel="Consultando o Banco Central…"
      variant="outline"
      messageClassName="max-w-xs"
    >
      <RefreshCw aria-hidden="true" />
      Atualizar agora
    </ActionButtonForm>
  );
}
