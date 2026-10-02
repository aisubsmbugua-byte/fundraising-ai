// CSV bulk import page -- STATE item 81, ruling 0034 clause 4. Mirrors
// app/(dashboard)/discovery/import/page.tsx's layout exactly: field
// documentation up top, a results banner reading from searchParams, a file
// picker form posting to the server action below it.
import { importSupportersCsv } from "../actions";
import SubmitButton from "@/components/SubmitButton";
import { SOURCE_TYPES, PLEDGE_FREQUENCIES } from "@/lib/supporters";
import { spacing, colors, fieldStyle } from "@/lib/ui";

export default function ImportSupportersPage({
  searchParams,
}: {
  searchParams: { imported?: string; errors?: string; duplicates?: string };
}) {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>Import Supporters from CSV</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        CSV should have a header row. Required: <code>name</code>. Optional:{" "}
        <code>email</code>, <code>phone</code>, <code>source_type</code> (must be one
        of: {SOURCE_TYPES.map((s) => s.value).join(", ")}), <code>source_detail</code>,{" "}
        <code>pledged_amount</code> (numeric), <code>pledged_frequency</code> (must be
        one of: {PLEDGE_FREQUENCIES.map((f) => f.value).join(", ")}), <code>notes</code>.
        Rows with a missing name, or an invalid <code>source_type</code> or{" "}
        <code>pledged_frequency</code>, are skipped.
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
          ✓ Imported {searchParams.imported} supporter{searchParams.imported === "1" ? "" : "s"}.
          {/* Counted and worded separately from errors. A skipped duplicate is
              the import working; an unreadable or invalid row is the import
              failing. One combined number would hide both. */}
          {Number(searchParams.duplicates) > 0 &&
            ` ${searchParams.duplicates} row(s) skipped — already a supporter.`}
          {Number(searchParams.errors) > 0 && ` ${searchParams.errors} row(s) skipped due to errors.`}
        </div>
      )}

      <form
        action={importSupportersCsv}
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
