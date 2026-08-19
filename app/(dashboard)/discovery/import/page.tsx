import { importCandidatesCsv } from "../actions";
import SubmitButton from "@/components/SubmitButton";
import { CHANNELS } from "@/lib/prospects";
import { spacing, colors, fieldStyle } from "@/lib/ui";

export default function ImportCandidatesPage({
  searchParams,
}: {
  searchParams: { imported?: string; errors?: string };
}) {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>Import Candidates from CSV</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        CSV should have a header row. Required: <code>name</code>, <code>channel</code> (must be one
        of: {CHANNELS.map((c) => c.value).join(", ")}). Optional: <code>organization</code>,{" "}
        <code>website</code>, <code>contact_name</code>, <code>contact_email</code>,{" "}
        <code>location</code>, <code>funder_type</code>, <code>geographic_focus</code>,{" "}
        <code>typical_grant_size</code>, <code>focus_areas</code> (comma-separated within the cell —
        quote the field if it contains commas, e.g.{" "}
        <code>&quot;Education, Youth Development&quot;</code>). Any of these you fill in won&apos;t be
        overwritten by the AI deep-dive later. Rows with a missing name or invalid channel are
        skipped.
      </p>

      {searchParams.imported !== undefined && (
        <div
          style={{
            background: "#dcfce7",
            color: "#166534",
            padding: spacing.sm,
            borderRadius: 6,
            marginTop: spacing.sm,
            fontSize: 14,
          }}
        >
          ✓ Imported {searchParams.imported} candidate{searchParams.imported === "1" ? "" : "s"}.
          {Number(searchParams.errors) > 0 && ` ${searchParams.errors} row(s) skipped due to errors.`}
        </div>
      )}

      <form
        action={importCandidatesCsv}
        style={{ display: "flex", gap: spacing.sm, marginTop: spacing.lg, alignItems: "center" }}
      >
        <input
          type="file"
          name="file"
          accept=".csv"
          required
          style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
        />
        <SubmitButton>Import</SubmitButton>
      </form>
    </div>
  );
}
