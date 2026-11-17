import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  LEADS_INTRO,
  LEADS_LIMIT_NOTE,
  LEADS_RULE,
  LEAD_PAGE_SIZE,
  NO_RETURN_MARK,
  describeLead,
  displayLeadName,
  leadKindLabel,
  leadMark,
  leadTierLabel,
  loadNoFilingLeads,
  type LeadPage,
  type NoFilingLead,
} from "@/lib/funder-reference/nofiling-leads";
import { describeIrs } from "@/lib/funder-reference/exempt-list";
import { readableName } from "@/lib/funder-reference/suggestions";
import { NOT_STATED, formatAmount, formatPeriodEnd } from "@/lib/funder-reference/browse";
import { cardStyle, chipStyle, colors, sectionStyle, spacing, type as typeScale } from "@/lib/ui";
import AddLeadButton from "./add-lead-button";

const muted = { color: colors.textMuted, fontSize: typeScale.meta } as const;

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, 160px) 1fr", gap: spacing.sm }}>
      <span style={muted}>{label}</span>
      <span style={{ overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function safeHref(url: string | null | undefined): string | null {
  return url && /^https:\/\//.test(url) ? url : null;
}

function CuratedPanel({ l }: { l: NoFilingLead }) {
  const c = l.curated;
  if (!c) return null;
  const site = safeHref(c.website);
  return (
    <details open style={{ marginTop: spacing.sm }}>
      <summary style={{ cursor: "pointer", fontSize: typeScale.body, color: colors.primary }}>What its own website says</summary>
      <div style={{ marginTop: spacing.sm, display: "grid", gap: spacing.xs, fontSize: typeScale.body }}>
        {site && (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(110px, 160px) 1fr", gap: spacing.sm }}>
            <span style={muted}>Website</span>
            <a href={site} target="_blank" rel="noreferrer noopener" style={{ color: colors.primary, overflowWrap: "anywhere" }}>
              {c.website}
            </a>
          </div>
        )}
        <Field label="Address" value={c.address} />
        <Field label="Contact" value={c.contact} />
        <Field label="Offers" value={c.offers} />
        <Field label="Why no filing" value={c.no_filing_note} />
        <Field label="EIN" value={l.stated_ein ? `${l.stated_ein.slice(0, 2)}-${l.stated_ein.slice(2)}. ${c.ein_note ?? ""}` : null} />
        <div style={{ display: "grid", gap: spacing.xs }}>
          <span style={muted}>Sources read{c.recorded_on ? ` (recorded ${formatPeriodEnd(c.recorded_on)})` : ""}</span>
          <ul style={{ margin: 0, paddingLeft: spacing.xl }}>
            {c.sources.map((s) => {
              const href = safeHref(s.url);
              return (
                <li key={s.url}>
                  {href ? (
                    <a href={href} target="_blank" rel="noreferrer noopener" style={{ color: colors.primary }}>
                      {s.title || s.url}
                    </a>
                  ) : (
                    s.title || "Source link not available"
                  )}
                  {s.read_on ? <span style={muted}> · read {formatPeriodEnd(s.read_on)}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </details>
  );
}

function SampleGrants({ l, links }: { l: NoFilingLead; links: LeadPage["links"] }) {
  if (l.sample.length === 0) return null;
  return (
    <details style={{ marginTop: spacing.sm }}>
      <summary style={{ cursor: "pointer", fontSize: typeScale.body, color: colors.primary }}>Show the grants that name it ({l.sample.length} most recent)</summary>
      <ul style={{ margin: `${spacing.sm}px 0 0`, paddingLeft: spacing.xl, fontSize: typeScale.body }}>
        {l.sample.map((g) => {
          const link = links[g.filing_object_id];
          return (
            <li key={`${g.filing_object_id}-${g.kind}-${g.ordinal}`} style={{ marginBottom: spacing.xs }}>
              {readableName(g.funder_name) || `EIN ${g.funder_ein}`} gave {formatAmount(g.amount_amt)} to {readableName(g.recipient) || "recipient not stated"}, tax year ended {formatPeriodEnd(g.tax_period_end)}
              {g.purpose ? <> · stated purpose: “{g.purpose}”</> : null}
              {" · "}
              {link ? (
                <a href={link.url} target="_blank" rel="noreferrer noopener" style={{ color: colors.primary }}>
                  the filing{link.member ? ` (${link.member})` : ""}
                </a>
              ) : (
                <span style={muted}>filing link not available</span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function Row({ l, links }: { l: NoFilingLead; links: LeadPage["links"] }) {
  const name = displayLeadName(l);
  const tier = leadTierLabel(l);
  return (
    <li style={{ ...cardStyle, listStyle: "none" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: spacing.lg, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
            <strong style={{ fontSize: typeScale.cardTitle }}>{name}</strong>
            <span style={chipStyle("neutral")}>{tier ?? leadKindLabel(l)}</span>
            <span style={chipStyle("amber")}>{leadMark(l)}</span>
          </div>
          <div style={{ ...muted, marginTop: spacing.xs }}>{[l.curated ? l.city : readableName(l.city), l.state].filter(Boolean).join(", ") || NOT_STATED}</div>
          <div style={{ marginTop: spacing.sm, fontSize: typeScale.body, display: "grid", gap: spacing.xs }}>
            {l.curated && <span>{NO_RETURN_MARK}.</span>}
            {describeLead(l).map((line) => (
              <span key={line}>{line}</span>
            ))}
            {describeIrs(l.irs).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
          <CuratedPanel l={l} />
          <SampleGrants l={l} links={links} />
        </div>
        <AddLeadButton leadKey={l.lead_key} name={name} />
      </div>
    </li>
  );
}

/** Funders with no return in the database (rulings 0051, 0052 and 0053). A server component: reads only, through the user's own session. */
export default async function ReferenceLeads({ page }: { page: number }) {
  const supabase = createClient();
  const main = await loadNoFilingLeads(supabase, page);
  const pages = Math.max(1, Math.ceil(main.total / LEAD_PAGE_SIZE));
  if (!main.error && main.rows.length === 0) return null;
  return (
    <section aria-labelledby="ref-leads" style={{ ...sectionStyle, marginBottom: spacing.xl }}>
      <div>
        <h2 id="ref-leads" style={{ fontSize: typeScale.sectionTitle, margin: 0 }}>
          Funders with no return in the database
        </h2>
        <p style={{ ...muted, marginTop: spacing.xs, fontSize: typeScale.body }}>{LEADS_INTRO}</p>
      </div>
      <div style={{ ...muted, display: "grid", gap: spacing.xs }}>
        <span>{LEADS_RULE}</span>
        <span>{LEADS_LIMIT_NOTE}</span>
      </div>
      {main.error && (
        <p role="alert" style={{ color: colors.danger }}>
          These funders could not be loaded: {main.error}
        </p>
      )}
      {main.rows.length > 0 && (
        <>
          <p style={{ ...muted, margin: 0 }}>
            {main.total.toLocaleString("en-US")} {main.total === 1 ? "funder" : "funders"}. Showing {(page - 1) * LEAD_PAGE_SIZE + 1}–{(page - 1) * LEAD_PAGE_SIZE + main.rows.length}.
          </p>
          <ul style={{ margin: 0, padding: 0, display: "grid", gap: spacing.md }}>
            {main.rows.map((l) => (
              <Row key={l.lead_key} l={l} links={main.links} />
            ))}
          </ul>
          {pages > 1 && (
            <nav aria-label="More funders that file no return" style={{ display: "flex", gap: spacing.md, alignItems: "center", ...muted }}>
              {page > 1 && <Link href={`/discovery?leadpage=${page - 1}`}>Previous</Link>}
              <span>
                Page {page} of {pages}
              </span>
              {page < pages && <Link href={`/discovery?leadpage=${page + 1}`}>Next</Link>}
            </nav>
          )}
        </>
      )}
    </section>
  );
}
