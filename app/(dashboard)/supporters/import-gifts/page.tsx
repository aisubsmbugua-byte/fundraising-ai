// Gift-history CSV bulk import page -- STATE item 82, ruling 0034 clauses 2
// and 4. Mirrors app/(dashboard)/supporters/import/page.tsx's layout exactly
// (itself mirroring app/(dashboard)/discovery/import/page.tsx): field
// documentation up top, a results banner reading searchParams, a file picker
// form posting to the server action below it.
//
// HARD BOUNDARY stated on the page itself, not just in code comments: this
// import creates NO supporters. It only logs gifts against supporters who
// already exist -- see /supporters/import (a different page, a different
// link) for adding new supporters.
import { importSupporterGiftsCsv } from "../actions";
import SubmitButton from "@/components/SubmitButton";
import { spacing, colors, fieldStyle } from "@/lib/ui";

export default function ImportSupporterGiftsPage({
  searchParams,
}: {
  searchParams: {
    imported?: string;
    errors?: string;
    noMatch?: string;
    ambiguous?: string;
    invalidAmount?: string;
    invalidDate?: string;
  };
}) {
  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Import Giving History from CSV</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        This import logs gifts against supporters who are <strong>already in your list</strong>. It
        never creates a new supporter -- a row that doesn&apos;t match an existing one is reported as
        an error, not added. To add new people, use{" "}
        <a href="/supporters/import">Import CSV</a> instead.
      </p>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        CSV should have a header row. Required: an identifier -- <code>supporter_email</code> OR{" "}
        <code>supporter_name</code> (at least one must be present and must match exactly one
        existing supporter), <code>amount</code> (numeric, greater than zero), <code>gift_date</code>{" "}
        (a valid date, e.g. <code>2026-03-15</code>). Optional: <code>note</code>.
      </p>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Matching rule: if <code>supporter_email</code> is given, it is matched first, exact and
        case-insensitive. Only when that finds no one does the row fall back to an exact,
        case-insensitive match on <code>supporter_name</code>. A row matching zero supporters is an
        error (&quot;no match&quot;). A row matching more than one supporter -- e.g. two people sharing a
        name -- is also an error (&quot;ambiguous match&quot;); it is never guessed.
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
          ✓ Imported {searchParams.imported} gift{searchParams.imported === "1" ? "" : "s"}.
          {/* Every error reason reported separately, never blended into one
              bucket (ruling 0021) -- a user fixing a rejected file needs to
              know WHICH rows failed WHY. */}
          {Number(searchParams.errors) > 0 &&
            (() => {
              const reasons = [
                Number(searchParams.noMatch) > 0 && `${searchParams.noMatch} no match`,
                Number(searchParams.ambiguous) > 0 && `${searchParams.ambiguous} ambiguous match`,
                Number(searchParams.invalidAmount) > 0 && `${searchParams.invalidAmount} invalid amount`,
                Number(searchParams.invalidDate) > 0 && `${searchParams.invalidDate} invalid date`,
              ].filter(Boolean);
              return ` ${searchParams.errors} row(s) skipped due to errors (${reasons.join(", ")}).`;
            })()}
        </div>
      )}

      <form
        action={importSupporterGiftsCsv}
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
