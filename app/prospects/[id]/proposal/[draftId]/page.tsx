// The proposal view (STATE item 71, part c): renders an APPROVED proposal
// draft as a letterhead-styled document. Mirrors the deck view
// (app/prospects/[id]/deck/[draftId]/page.tsx) exactly in every way that
// isn't about the artifact's own shape: approved-drafts-only, deterministic
// parse via the SAME shared parser (parseDeckOutline from
// lib/deck-outline), zero model calls, no external PDF library, shared
// lib/ui.ts tokens, browser print-to-PDF as the v1 export labelled
// on-screen. What differs is what a proposal actually IS: a flowing
// document, not a slide-per-page deck, so it renders as continuous pages
// with the org's letterhead (logo + brand colors) appearing ONCE at the
// top -- not repeated as a running header on every printed page. That is
// a deliberate choice, not an oversight: a running header repeating the
// logo on every page is the more "print-native" option, but a grant
// proposal is conventionally read as one continuous document with a
// single cover/letterhead, the same way a Word or Google Docs export
// would render it, and a repeating header would visually fight the
// document's own section headings for attention on every page. If a human
// reviewer later wants the running-header treatment, that's a one-file
// change here -- it never touches the deck view, which keeps its own
// slide-per-page behavior untouched (not authorized to change here).
//
// This route lives OUTSIDE the (dashboard) route group for the identical
// reason the deck view does: the dashboard layout's sidebar shell would
// render onto the screen view and onto every printed page. The URL stays
// under /prospects/..., so the middleware's auth gate (which matches the
// "/prospects" prefix) covers it exactly as it covers the deck route, and
// the page re-checks the session itself like every dashboard page does.
//
// An UNAPPROVED proposal draft never renders as a document: it gets a
// plain message pointing back to review (rule 3 -- the proposal view is
// downstream of the approval, not a preview of it).

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseDeckOutline } from "@/lib/deck-outline";
import { isValidHexColor, type OrgProfile } from "@/lib/organization";
import { colors, spacing, type as typeScale, radiusSm, buttonSecondary } from "@/lib/ui";
import type { Draft } from "@/lib/drafts";

// Print rules can't be expressed in inline styles, so this one page
// carries a small real stylesheet, same device as the deck view. Colors
// come through as CSS custom properties set on the page root (below) --
// the org's own brand applied to the document, or the app's own default
// navy/teal when no branding is on file (never an invented color, never
// left unset).
const proposalCss = `
  .proposal-page {
    background: ${colors.surface};
    max-width: 720px;
    margin: 0 auto;
    padding: 64px 72px;
    box-sizing: border-box;
    color: ${colors.text};
  }
  .proposal-letterhead {
    display: flex;
    align-items: center;
    gap: ${spacing.lg}px;
    padding-bottom: ${spacing.lg}px;
    border-bottom: 3px solid var(--proposal-primary);
    margin-bottom: ${spacing.xl}px;
  }
  .proposal-letterhead img {
    max-height: 64px;
    max-width: 200px;
    object-fit: contain;
  }
  .proposal-frontmatter {
    display: grid;
    gap: 2px;
    margin-bottom: ${spacing.xxl}px;
    color: ${colors.textMuted};
    font-size: ${typeScale.body}px;
  }
  .proposal-section {
    margin-bottom: ${spacing.xxl}px;
  }
  .proposal-section h2 {
    color: var(--proposal-primary);
    font-size: ${typeScale.sectionTitle}px;
    border-bottom: 1px solid ${colors.border};
    padding-bottom: ${spacing.xs}px;
    margin: 0 0 ${spacing.md}px 0;
  }
  .proposal-section p {
    font-size: ${typeScale.body}px;
    line-height: 1.65;
    margin: 0 0 ${spacing.sm}px 0;
  }
  .proposal-evidence {
    margin-top: ${spacing.md}px;
    padding-top: ${spacing.sm}px;
    border-top: 1px dashed ${colors.border};
    display: grid;
    gap: ${spacing.xs}px;
  }
  .proposal-evidence div {
    font-size: ${typeScale.meta}px;
    color: var(--proposal-accent);
  }
  @media print {
    .proposal-screen-only { display: none !important; }
    .proposal-page { max-width: none; padding: 0; }
    body { background: ${colors.surface} !important; }
  }
  @page { size: portrait; margin: 0.75in; }
`;

export default async function ProposalViewPage({ params }: { params: { id: string; draftId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Fetched by draft id AND prospect id, same as the deck view -- a draft
  // id pasted under the wrong prospect's URL resolves to nothing. No
  // enum-literal filter on kind: compared in code, so this page also
  // loads cleanly against a database that predates migration 0071.
  const { data: draft } = await supabase
    .from("drafts")
    .select("*")
    .eq("id", params.draftId)
    .eq("prospect_id", params.id)
    .maybeSingle<Draft>();
  if (!draft || draft.kind !== "proposal") notFound();

  const { data: prospect } = await supabase
    .from("prospects")
    .select("name")
    .eq("id", params.id)
    .maybeSingle<{ name: string }>();
  const prospectName = prospect?.name ?? "this prospect";

  if (draft.status !== "approved") {
    // A plain message, never the document: the proposal renders only
    // from what was approved, same rule as the deck view.
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: spacing.xxl }}>
        <h1 style={{ fontSize: typeScale.sectionTitle }}>This proposal is not approved yet</h1>
        <p style={{ fontSize: typeScale.body, color: colors.textMuted, marginTop: spacing.sm }}>
          The proposal document renders only from an approved draft, so what appears here is exactly what
          a human signed off on. Review and approve the proposal on the prospect&apos;s Strategy tab, then
          come back here.
        </p>
        <div style={{ marginTop: spacing.lg }}>
          <Link href={`/prospects/${params.id}?tab=strategy`} style={buttonSecondary}>
            Go to the proposal for review
          </Link>
        </div>
      </main>
    );
  }

  // The SAME parser the deck view and generateProposalDraft's header both
  // rely on -- one definition, no drift. A "slide" with title === null
  // (any body lines written before the first "#") is this proposal's
  // letterhead front matter, not a section.
  const outline = parseDeckOutline(draft.content);
  const frontMatter = outline.slides.find((s) => s.title === null) ?? null;
  const sections = outline.slides.filter((s) => s.title !== null);

  // Footnote attributions resolve from the evidence library, read-only --
  // identical query shape to the deck view.
  const { data: evidenceRows } =
    outline.evidenceIds.length > 0
      ? await supabase.from("evidence_items").select("id, title, type").in("id", outline.evidenceIds)
      : { data: [] as { id: string; title: string; type: string }[] };
  const evidenceById = new Map((evidenceRows ?? []).map((e) => [e.id, e]));

  // Org branding (STATE item 71, migration 0073): read-only, org-scoped by
  // org_profile's own RLS policy -- no explicit organization_id filter
  // needed here, same as every other org_profile read in this codebase.
  // An org with no row, or a row with null colors/logo, renders with the
  // app's own defaults below -- never a broken image, never an invented
  // color.
  const { data: profile } = await supabase
    .from("org_profile")
    .select("name, logo_path, primary_color, accent_color")
    .limit(1)
    .maybeSingle<Pick<OrgProfile, "name" | "logo_path" | "primary_color" | "accent_color">>();

  const logoUrl = profile?.logo_path ? supabase.storage.from("org-logos").getPublicUrl(profile.logo_path).data.publicUrl : null;
  // Re-validated here even though migration 0073's check constraint
  // already guarantees the shape at write time -- this value is about to
  // be interpolated into a CSS custom property, so it is never trusted
  // without a local check of its own (lib/organization.ts's
  // isValidHexColor, shared with the Org Settings save action).
  const primaryColor = profile?.primary_color && isValidHexColor(profile.primary_color) ? profile.primary_color : colors.navy900;
  const accentColor = profile?.accent_color && isValidHexColor(profile.accent_color) ? profile.accent_color : colors.teal700;

  return (
    <main
      style={{
        background: colors.canvas,
        padding: `${spacing.xl}px 0`,
        minHeight: "100vh",
        // CSS custom properties carrying the org's brand (or the app's
        // own default) down into proposalCss's rules -- the mechanism
        // part (c) asks for.
        ["--proposal-primary" as string]: primaryColor,
        ["--proposal-accent" as string]: accentColor,
      } as React.CSSProperties}
    >
      <style>{proposalCss}</style>

      <div
        className="proposal-screen-only"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: spacing.md,
          maxWidth: 720,
          margin: "0 auto",
          padding: `0 0 ${spacing.md}px`,
        }}
      >
        <div style={{ fontSize: typeScale.meta, color: colors.textMuted }}>
          Approved proposal for {prospectName} — use your browser&apos;s Print and choose &quot;Save as
          PDF&quot; for the exportable document.
        </div>
        <Link href={`/prospects/${params.id}?tab=strategy`} style={{ ...buttonSecondary, padding: "6px 12px", fontSize: typeScale.meta, flexShrink: 0 }}>
          Back to prospect
        </Link>
      </div>

      <article className="proposal-page">
        <div className="proposal-letterhead">
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- a Supabase Storage public URL, not a local asset
            <img src={logoUrl} alt={profile?.name ? `${profile.name} logo` : "Organization logo"} />
          )}
          {profile?.name && (
            <div style={{ fontSize: typeScale.sectionTitle, fontWeight: 600, color: colors.navy900 }}>{profile.name}</div>
          )}
        </div>

        {frontMatter && frontMatter.bullets.length > 0 && (
          <div className="proposal-frontmatter">
            {frontMatter.bullets.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}

        {sections.length === 0 && (
          <p style={{ fontSize: typeScale.bodyLg, color: colors.textMuted }}>
            The approved proposal contains no sections. Add &quot;# &quot; section-heading lines to it in
            the draft editor (its own header explains the format), re-approve, and this page will render
            them.
          </p>
        )}

        {sections.map((section, i) => (
          <section key={i} className="proposal-section">
            <h2>{section.title}</h2>
            {section.bullets.map((line, j) => (
              <p key={j}>{line}</p>
            ))}
            {section.evidenceIds.length > 0 && (
              <div className="proposal-evidence">
                {section.evidenceIds.map((id) => {
                  const item = evidenceById.get(id);
                  return (
                    <div key={id}>
                      {item
                        ? `Source: ${item.title} (${item.type}, evidence library)`
                        : `Source: evidence item ${id} — not found in the evidence library`}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </article>

      <div
        className="proposal-screen-only"
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: spacing.xl,
          textAlign: "center",
          fontSize: typeScale.meta,
          color: colors.textFaint,
          borderRadius: radiusSm,
        }}
      >
        Rendered exactly from the approved proposal — no AI involved in this view.
      </div>
    </main>
  );
}
