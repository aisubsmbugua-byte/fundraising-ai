"use client";

// The logo half of Org Settings' branding UI (STATE item 71, part a). A
// client component (not a plain <form action={...}>) because
// uploadOrgLogo/removeOrgLogo return { ok } | { error } that a bare form
// action would discard -- the same reason ComposeSection in draft-panel.tsx
// drives composeDraft through useTransition instead of a plain form.

import { useRef, useState, useTransition } from "react";
import { uploadOrgLogo, removeOrgLogo } from "./branding-actions";
import ConfirmDialog from "@/components/ConfirmDialog";
import { spacing, colors, labelStyle, buttonPrimary, buttonSecondary, cardStyle } from "@/lib/ui";

export default function LogoUpload({ logoUrl, logoPath }: { logoUrl: string | null; logoPath: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await uploadOrgLogo(formData);
      if ("error" in result) {
        setError(result.error);
      } else if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    });
  }

  return (
    <div style={cardStyle}>
      <div style={{ ...labelStyle, marginBottom: spacing.xs }}>Organization logo</div>
      <p style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 0, marginBottom: spacing.sm }}>
        Appears on the letterhead of proposal documents. PNG, JPEG, SVG, or WebP, 5MB max. No logo set
        means proposals render with no logo, never a broken image.
      </p>
      {logoUrl && (
        <div style={{ display: "flex", alignItems: "center", gap: spacing.md, marginBottom: spacing.sm }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a Supabase Storage public URL, not a local asset next/image can optimize */}
          <img
            src={logoUrl}
            alt="Organization logo"
            style={{
              maxHeight: 56,
              maxWidth: 160,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              background: colors.surface,
              padding: spacing.xs,
              boxSizing: "border-box",
            }}
          />
          <button type="button" disabled={isPending} onClick={() => setConfirmRemove(true)} style={buttonSecondary}>
            Remove logo
          </button>
        </div>
      )}
      <form onSubmit={handleUpload} style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={fileInputRef}
          type="file"
          name="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          required
        />
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Uploading…" : logoUrl ? "Replace logo" : "Upload logo"}
        </button>
      </form>
      {error && <p style={{ fontSize: 12, color: colors.danger, marginTop: spacing.xs }}>{error}</p>}

      <ConfirmDialog
        open={confirmRemove}
        title="Remove logo"
        message="Remove the organization logo? Proposal documents will render with no logo until a new one is uploaded."
        confirmLabel="Remove"
        danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false);
          if (!logoPath) return;
          startTransition(async () => {
            const result = await removeOrgLogo(logoPath);
            if ("error" in result) setError(result.error);
          });
        }}
      />
    </div>
  );
}
