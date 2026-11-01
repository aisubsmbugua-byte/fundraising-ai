"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { importConnections, previewConnectionImport, type ImportResult } from "../import-actions";
import { CONNECTION_STRENGTHS, NETWORK_IMPORT_DISCLOSURE } from "@/lib/network";
import {
  EMPTY_MAPPING,
  HEADING_ALIASES,
  NETWORK_IMPORT_MAX_FILE_BYTES,
  NETWORK_IMPORT_MAX_ROWS,
  classifyImportRows,
  countsAddUp,
  describeColumns,
  firstNonBlankRecord,
  headingRowCandidates,
  mappableColumns,
  notImportedSentence,
  readCsvRecords,
  reduceMapping,
  suggestMapping,
  tableFromRecords,
  type ColumnInfo,
  type CsvTable,
  type FieldMapping,
  type ImportCounts,
} from "@/lib/network-import";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, sectionStyle, cardStyle } from "@/lib/ui";

const STRENGTH_LABEL: Record<string, string> = { close: "Close", warm: "Warm", acquaintance: "Acquaintance" };

function ColumnSelect({
  label,
  hint,
  value,
  onChange,
  columns,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  columns: ColumnInfo[];
  placeholder: string;
}) {
  return (
    <label style={labelStyle}>
      {label}
      <select style={fieldStyle} value={value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
        <option value="">{placeholder}</option>
        {columns.map((c) => (
          <option key={c.index} value={c.index}>
            {c.label}
          </option>
        ))}
      </select>
      {hint && <span style={{ display: "block", marginTop: spacing.xs, fontSize: 12 }}>{hint}</span>}
    </label>
  );
}

type Check =
  | { status: "idle" }
  | { status: "checking"; payload: string }
  | { status: "ready"; payload: string; counts: ImportCounts }
  | { status: "error"; payload: string; message: string };

export default function ImportWorkspace() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [records, setRecords] = useState<string[][] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [headerRow, setHeaderRow] = useState(0);
  const [mapping, setMapping] = useState<FieldMapping>(EMPTY_MAPPING);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [check, setCheck] = useState<Check>({ status: "idle" });
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importedColumns, setImportedColumns] = useState<string[] | null>(null);
  const [notImportedAtRun, setNotImportedAtRun] = useState<string[]>([]);
  // Bumped after an import attempt so the duplicate check is asked again: the
  // people just imported are now "already on your Network".
  const [checkNonce, setCheckNonce] = useState(0);
  const [isPending, startTransition] = useTransition();

  const table = useMemo(() => (records ? tableFromRecords(records, headerRow) : null), [records, headerRow]);
  const columns = useMemo(() => (table ? describeColumns(table) : []), [table]);
  const options = useMemo(() => (table ? mappableColumns(table) : []), [table]);
  const reduced = useMemo(() => (table ? reduceMapping(table, mapping) : null), [table, mapping]);
  // The rows alone (strength is not among them), so changing the strength does
  // not re-ask the server about duplicates.
  const payload = useMemo(() => (reduced && reduced.rows.length > 0 ? JSON.stringify(reduced.rows) : ""), [reduced]);
  const local = useMemo(() => (reduced ? classifyImportRows(reduced.rows, new Set()) : null), [reduced]);

  // Ask the server how many rows duplicate people already recorded, using the
  // very classification the import will use. Nothing is written.
  useEffect(() => {
    if (!payload || !reduced || reduced.rows.length > NETWORK_IMPORT_MAX_ROWS) {
      setCheck({ status: "idle" });
      return;
    }
    let cancelled = false;
    setCheck({ status: "checking", payload });
    const timer = setTimeout(async () => {
      try {
        const r = await previewConnectionImport(JSON.parse(payload), {});
        if (cancelled) return;
        if ("error" in r) setCheck({ status: "error", payload, message: r.error });
        else setCheck({ status: "ready", payload, counts: r.counts });
      } catch {
        if (!cancelled) setCheck({ status: "error", payload, message: "Could not check for people you already have recorded." });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, checkNonce]);

  const loadFile = async (file: File | undefined) => {
    setResult(null);
    setImportedColumns(null);
    setReadError(null);
    setCheck({ status: "idle" });
    if (!file) return;
    if (file.size > NETWORK_IMPORT_MAX_FILE_BYTES) {
      setRecords(null);
      setFileName(null);
      setReadError(`That file is ${(file.size / 1_000_000).toFixed(1)} MB; the page reads files up to ${NETWORK_IMPORT_MAX_FILE_BYTES / 1_000_000} MB. Split it and import it in parts.`);
      return;
    }
    const text = await file.text();
    const recs = readCsvRecords(text);
    const first = firstNonBlankRecord(recs);
    if (first < 0) {
      setRecords(null);
      setFileName(null);
      setReadError("That file is empty.");
      return;
    }
    const t = tableFromRecords(recs, first);
    setRecords(recs);
    setFileName(file.name);
    setHeaderRow(first);
    const m = t ? suggestMapping(t) : EMPTY_MAPPING;
    setMapping(m);
    setSuggested(t ? suggestionList(t, m) : []);
  };

  const changeHeaderRow = (i: number) => {
    setHeaderRow(i);
    const t = records ? tableFromRecords(records, i) : null;
    const m = t ? suggestMapping(t) : EMPTY_MAPPING;
    setMapping(m);
    setSuggested(t ? suggestionList(t, m) : []);
    setResult(null);
  };

  const set = <K extends keyof FieldMapping>(key: K, value: FieldMapping[K]) => {
    setResult(null);
    setMapping((m) => ({ ...m, [key]: value }));
  };

  // Server counts once they have come back for THIS mapping; otherwise the
  // page's own count (everything except people already recorded).
  const serverReady = check.status === "ready" && check.payload === payload ? check.counts : null;
  const counts: ImportCounts | null = serverReady ?? local?.counts ?? null;
  const importReady = !!reduced && reduced.canImport && !!serverReady && countsAddUp(serverReady) && serverReady.toImport > 0 && !(result && "success" in result);

  const runImport = () => {
    if (!reduced || !serverReady) return;
    const rows = JSON.parse(payload);
    setNotImportedAtRun(reduced.notImported.map((c) => c.label));
    setImportedColumns(columns.filter((c) => !reduced.notImported.some((n) => n.index === c.index)).map((c) => c.label));
    startTransition(async () => {
      try {
        setResult(await importConnections(rows, { strength: mapping.strength }));
        setCheckNonce((n) => n + 1);
      } catch {
        setResult({ error: "The import could not be completed, and it is not known how much of it was written. Check the Network page before trying again." });
        setCheckNonce((n) => n + 1);
      }
    });
  };

  const contactColumns = reduced?.notImported.filter((c) => c.contact) ?? [];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.lg, marginTop: spacing.lg }}>
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: colors.text,
          background: colors.amber100,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          padding: spacing.md,
          maxWidth: 760,
        }}
      >
        {NETWORK_IMPORT_DISCLOSURE}
      </p>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 17, margin: 0 }}>1. Choose a file</h2>
        <label style={labelStyle}>
          A CSV file (.csv) with a row of column headings
          <input type="file" accept=".csv,text/csv" style={fieldStyle} onChange={(e) => loadFile(e.target.files?.[0])} />
        </label>
        {readError && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{readError}</p>}
        {fileName && table && (
          <p style={{ fontSize: 13, margin: 0, color: colors.textMuted }}>
            {fileName}: {table.headers.length} columns and {table.rows.length} rows under the headings. The file stays in your browser until you import.
          </p>
        )}
        {records && headingRowCandidates(records).length > 1 && (
          <label style={labelStyle}>
            The column headings are on row
            <select style={{ ...fieldStyle, maxWidth: 200 }} value={headerRow} onChange={(e) => changeHeaderRow(Number(e.target.value))}>
              {headingRowCandidates(records).map((i) => (
                <option key={i} value={i}>
                  Row {i + 1}
                </option>
              ))}
            </select>
            <span style={{ display: "block", marginTop: spacing.xs, fontSize: 12 }}>
              Some exports begin with a few lines of notes before the headings. Rows above the headings are ignored.
            </span>
          </label>
        )}
      </section>

      {table && reduced && (
        <>
          <section style={sectionStyle}>
            <h2 style={{ fontSize: 17, margin: 0 }}>2. What is in the file</h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12.5, minWidth: "100%" }}>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.index} style={{ textAlign: "left", padding: spacing.xs, borderBottom: `1px solid ${colors.border}`, whiteSpace: "nowrap" }}>
                        {c.headingless ? <em>(no heading)</em> : c.heading}
                        {c.contact && <div style={{ fontWeight: 400, color: colors.danger }}>contact details — never stored</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.slice(0, 5).map((r, ri) => (
                    <tr key={ri}>
                      {columns.map((c) => (
                        <td key={c.index} style={{ padding: spacing.xs, borderBottom: `1px solid ${colors.border}`, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: c.contact ? colors.textMuted : colors.text }}>
                          {c.contact ? "not shown" : r[c.index]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 12.5, color: colors.textMuted, margin: 0 }}>The first {Math.min(5, table.rows.length)} of {table.rows.length} rows.</p>
          </section>

          <section style={sectionStyle}>
            <h2 style={{ fontSize: 17, margin: 0 }}>3. Say which column is which</h2>
            {suggested.length > 0 ? (
              <p style={{ fontSize: 13, margin: 0 }}>
                Some choices below were pre-selected because a column heading exactly matched a common name: {suggested.join("; ")}. They are only suggestions — check
                each one and change it if it is wrong. Nothing else is chosen for you.
              </p>
            ) : (
              <p style={{ fontSize: 13, margin: 0 }}>No heading exactly matched a common name, so nothing is pre-selected. Choose each column yourself.</p>
            )}
            <details style={{ fontSize: 12.5, color: colors.textMuted }}>
              <summary style={{ cursor: "pointer" }}>How suggestions are made</summary>
              <p style={{ margin: `${spacing.xs}px 0 0` }}>
                A heading is pre-selected only when it is exactly one of these (ignoring capitals and punctuation). Name: {HEADING_ALIASES.name.join(", ")}. First name:{" "}
                {HEADING_ALIASES.first.join(", ")}. Last name: {HEADING_ALIASES.last.join(", ")}. Affiliation: {HEADING_ALIASES.affiliation.join(", ")}. Role or title:{" "}
                {HEADING_ALIASES.role.join(", ")}. How you know them: {HEADING_ALIASES.howKnown.join(", ")}. Notes: {HEADING_ALIASES.notes.join(", ")}.
              </p>
            </details>

            <fieldset style={{ border: "none", padding: 0, margin: 0, display: "grid", gap: spacing.sm }}>
              <legend style={{ ...labelStyle, padding: 0 }}>Name (required)</legend>
              <div style={{ display: "flex", gap: spacing.lg, fontSize: 13 }}>
                <label style={{ display: "flex", gap: spacing.xs, alignItems: "center" }}>
                  <input type="radio" name="nameMode" checked={mapping.nameMode === "single"} onChange={() => set("nameMode", "single")} />
                  One column holds the whole name
                </label>
                <label style={{ display: "flex", gap: spacing.xs, alignItems: "center" }}>
                  <input type="radio" name="nameMode" checked={mapping.nameMode === "split"} onChange={() => set("nameMode", "split")} />
                  First name and last name are separate columns
                </label>
              </div>
              {mapping.nameMode === "single" ? (
                <ColumnSelect label="Name column" value={mapping.name} onChange={(v) => set("name", v)} columns={options} placeholder="Choose a column" />
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: spacing.md }}>
                  <ColumnSelect label="First name column" value={mapping.first} onChange={(v) => set("first", v)} columns={options} placeholder="Choose a column" />
                  <ColumnSelect label="Last name column" value={mapping.last} onChange={(v) => set("last", v)} columns={options} placeholder="Choose a column" />
                </div>
              )}
              {mapping.nameMode === "split" && <span style={{ fontSize: 12, color: colors.textMuted }}>The two are joined with a space: First Last.</span>}
            </fieldset>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: spacing.md }}>
              <ColumnSelect label="Where they work or serve (optional)" value={mapping.affiliation} onChange={(v) => set("affiliation", v)} columns={options} placeholder="Not imported" />
              <ColumnSelect
                label="Role or title (optional)"
                hint="Joined to the affiliation as “Role, Affiliation” — or just the role when there is no affiliation."
                value={mapping.role}
                onChange={(v) => set("role", v)}
                columns={options}
                placeholder="Not imported"
              />
              <ColumnSelect label="Notes (optional)" hint="Notes are shared with the AI service when paths are looked for." value={mapping.notes} onChange={(v) => set("notes", v)} columns={options} placeholder="Not imported" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: spacing.md }}>
              <ColumnSelect label="How you know them — a column" value={mapping.howKnown} onChange={(v) => set("howKnown", v)} columns={options} placeholder="No column" />
              <label style={labelStyle}>
                How you know them — one sentence {mapping.howKnown === null ? "(required when there is no column)" : "(used for rows where that column is empty)"}
                <input
                  style={fieldStyle}
                  value={mapping.howKnownSentence}
                  onChange={(e) => set("howKnownSentence", e.target.value)}
                  placeholder="For example: From our 2024 donor list"
                />
                <span style={{ display: "block", marginTop: spacing.xs, fontSize: 12 }}>
                  This is how the batch&apos;s origin is recorded — the file&apos;s name is not kept.
                </span>
              </label>
            </div>

            <label style={{ ...labelStyle, maxWidth: 320 }}>
              How close you are to these people (required — applies to everyone in this file)
              <select style={fieldStyle} value={mapping.strength} onChange={(e) => set("strength", e.target.value)}>
                <option value="" disabled>
                  Choose one
                </option>
                {CONNECTION_STRENGTHS.map((s) => (
                  <option key={s} value={s}>
                    {STRENGTH_LABEL[s]}
                  </option>
                ))}
              </select>
              <span style={{ display: "block", marginTop: spacing.xs, fontSize: 12 }}>There is no default and nothing is worked out from the data.</span>
            </label>
          </section>

          <section style={sectionStyle}>
            <h2 style={{ fontSize: 17, margin: 0 }}>4. What will NOT be imported ({reduced.notImported.length} of {columns.length} columns)</h2>
            {contactColumns.length > 0 && (
              <p style={{ fontSize: 13, margin: 0, color: colors.danger }}>
                {contactColumns.length === 1 ? "One column looks" : `${contactColumns.length} columns look`} like contact details or a handle (
                {contactColumns.map((c) => c.heading).join(", ")}). Contact details are never stored, and these columns cannot be used for anything.
              </p>
            )}
            {reduced.notImported.length === 0 ? (
              <p style={{ fontSize: 13, margin: 0 }}>Every column in the file is used.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: "grid", gap: 2 }}>
                {reduced.notImported.map((c) => (
                  <li key={c.index} style={{ color: c.contact ? colors.danger : colors.text }}>
                    {notImportedSentence(c)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section style={sectionStyle}>
            <h2 style={{ fontSize: 17, margin: 0 }}>5. Check, then import</h2>
            {reduced.preview.length > 0 && (
              <div style={{ display: "grid", gap: spacing.sm }}>
                <p style={{ fontSize: 13, margin: 0 }}>How the first {reduced.preview.length} {reduced.preview.length === 1 ? "person" : "people"} will be recorded:</p>
                {reduced.preview.map((p, i) => (
                  <div key={i} style={cardStyle}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{p.person_name}</div>
                    <div style={{ fontSize: 13, color: colors.textMuted }}>{p.affiliation ?? "(no affiliation)"}</div>
                    <div style={{ fontSize: 13 }}>
                      <span style={{ color: colors.textMuted }}>How you know them: </span>
                      {p.how_known ?? "(not recorded)"} ·{" "}
                      <span style={{ color: colors.textMuted }}>Strength: </span>
                      {mapping.strength ? STRENGTH_LABEL[mapping.strength] : "(not chosen yet)"}
                    </div>
                    {p.notes && <div style={{ fontSize: 13, color: colors.textMuted }}>{p.notes}</div>}
                  </div>
                ))}
              </div>
            )}

            {counts && reduced.rows.length > 0 && (
              <div style={{ fontSize: 13 }}>
                <p style={{ margin: 0 }}>
                  <strong>Rows read: {reduced.rowsRead}</strong> under the headings
                  {reduced.blankRows > 0 ? `, of which ${reduced.blankRows} are blank and are skipped` : ""}. Of the {counts.received} rows with something in them:
                </p>
                <ul style={{ margin: `${spacing.xs}px 0 0`, paddingLeft: 18 }}>
                  <li>
                    <strong>{counts.toImport}</strong> will be imported{serverReady ? "" : " (not final: still checking against the people you already have)"}
                  </li>
                  <li>
                    {serverReady ? counts.duplicateExisting : "…"} are already on your Network (same name and affiliation) and will be skipped
                  </li>
                  <li>{counts.duplicateInFile} repeat an earlier row in this file and will be skipped</li>
                  <li>{counts.missingName} have no name and will be skipped</li>
                  <li>{counts.tooLong} have a field that is too long and will be skipped, not shortened</li>
                </ul>
                {check.status === "error" && check.payload === payload && <p style={{ color: colors.danger, margin: `${spacing.xs}px 0 0` }}>{check.message}</p>}
              </div>
            )}

            {reduced.blockers.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: colors.danger, display: "grid", gap: 2 }}>
                {reduced.blockers.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            )}

            <div>
              <button type="button" style={buttonPrimary} disabled={!importReady || isPending} onClick={runImport}>
                {isPending ? "Importing…" : serverReady ? `Import ${serverReady.toImport} ${serverReady.toImport === 1 ? "person" : "people"}` : "Import"}
              </button>
              <span style={{ marginLeft: spacing.sm, fontSize: 12.5, color: colors.textMuted }}>
                Nothing is sent to anyone. If this turns out to be a mistake, remove the people on the Network page.
              </span>
            </div>

            {result && "error" in result && (
              <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{result.error}</p>
            )}
            {result && "success" in result && (
              <div style={{ ...cardStyle, fontSize: 13 }}>
                <p style={{ margin: 0 }}>
                  <strong>Imported {result.imported} {result.imported === 1 ? "person" : "people"}.</strong> Skipped: {result.counts.duplicateExisting} already on your Network,{" "}
                  {result.counts.duplicateInFile} repeated in the file, {result.counts.missingName} without a name, {result.counts.tooLong} with a field too long (of {result.counts.received} rows).
                </p>
                {notImportedAtRun.length > 0 && <p style={{ margin: `${spacing.xs}px 0 0` }}>Columns that were not imported: {notImportedAtRun.join("; ")}.</p>}
                {importedColumns && <p style={{ margin: `${spacing.xs}px 0 0`, color: colors.textMuted }}>Columns used: {importedColumns.join("; ")}.</p>}
                <p style={{ margin: `${spacing.xs}px 0 0` }}>
                  <Link href="/network" style={{ color: colors.text }}>
                    See them on the Network page
                  </Link>
                </p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// "Company → Where they work or serve" lines for what was pre-selected.
function suggestionList(table: CsvTable, m: FieldMapping): string[] {
  const label = (i: number | null) => (i === null ? null : table.headers[i]);
  const out: string[] = [];
  if (m.nameMode === "single" && m.name !== null) out.push(`“${label(m.name)}” for Name`);
  if (m.nameMode === "split") out.push(`“${label(m.first)}” and “${label(m.last)}” for First and Last name`);
  if (m.affiliation !== null) out.push(`“${label(m.affiliation)}” for Where they work or serve`);
  if (m.role !== null) out.push(`“${label(m.role)}” for Role or title`);
  if (m.howKnown !== null) out.push(`“${label(m.howKnown)}” for How you know them`);
  if (m.notes !== null) out.push(`“${label(m.notes)}” for Notes`);
  return out;
}
