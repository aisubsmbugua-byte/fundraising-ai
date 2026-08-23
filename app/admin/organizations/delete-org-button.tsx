"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { deleteOrganization } from "./actions";
import { buttonSecondary, colors } from "@/lib/ui";

export default function DeleteOrgButton({ organizationId, name }: { organizationId: string; name: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        title="Delete organization"
        disabled={isPending}
        onClick={() => {
          setError(null);
          if (!confirm(`Delete "${name}"? This can't be undone -- only works if the organization has no data in it yet.`)) return;
          startTransition(async () => {
            try {
              await deleteOrganization(organizationId);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to delete");
            }
          });
        }}
        style={{ ...buttonSecondary, padding: "6px 8px", color: colors.red600 }}
      >
        <Trash2 size={14} />
      </button>
      {error && <p style={{ color: colors.red600, fontSize: 12, marginTop: 4, maxWidth: 220 }}>{error}</p>}
    </div>
  );
}
