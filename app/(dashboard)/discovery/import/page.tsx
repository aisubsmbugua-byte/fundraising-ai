import { importCandidatesCsv } from "../actions";
import SubmitButton from "@/components/SubmitButton";
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
        CSV should have a header row with these columns: <code>name</code>, <code>channel</code> (must
        be one of: foundation, regranting, christian_business, denomination, daf, major_donor),{" "}
        <code>organization</code>, <code>website</code>, <code>contact_name</code>,{" "}
        <code>contact_email</code>. Rows with a missing name or invalid channel are skipped.
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
