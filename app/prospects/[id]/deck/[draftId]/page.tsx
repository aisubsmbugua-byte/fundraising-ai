// The deck view (STATE item 66): renders an APPROVED deck-outline draft
// as a print-styled slide page. Deterministic all the way down -- the
// slides are parseDeckOutline over the exact text a human approved, with
// zero model calls and no external deck/PDF library; browser print-to-PDF
// is the v1 export, and the page says so on screen.
//
// This route lives OUTSIDE the (dashboard) route group on purpose: the
// dashboard layout wraps every child in the sidebar shell, which would
// render chrome onto the screen view and onto every printed page. The URL
// stays under /prospects/..., so the middleware's auth gate covers it
// exactly as it covers the prospect page, and the page re-checks the
// session itself like every dashboard page does.
//
// An UNAPPROVED deck draft never renders as slides: it gets a plain
// message pointing back to review (rule 3 -- the deck is downstream of
// the approval, not a preview of it).

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseDeckOutline } from "@/lib/deck-outline";
import { colors, spacing, type as typeScale, radiusSm, buttonSecondary } from "@/lib/ui";
import type { Draft } from "@/lib/drafts";

// Print rules can't be expressed in inline styles, so this one page
// carries a small real stylesheet: one slide per full-viewport section on
// screen, one slide per page in print, screen-only chrome hidden.
const deckCss = `
  .deck-slide {
    min-height: 100vh;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 48px 64px;
    border-bottom: 1px solid ${colors.border};
    background: ${colors.surface};
  }
  @media print {
    .deck-screen-only { display: none !important; }
    .deck-slide {
      /* One slide per printed page: sized by its content, broken after.
         A fixed 100vh here would clip a full slide, so the break rule
         carries the one-per-page guarantee instead. */
      min-height: 0;
      border-bottom: none;
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .deck-slide:last-of-type { page-break-after: auto; break-after: auto; }
    body { background: ${colors.surface} !important; }
  }
  @page { size: landscape; margin: 0; }
`;

export default async function DeckViewPage({ params }: { params: { id: string; draftId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The draft is fetched by id AND prospect id, so a draft id pasted under
  // the wrong prospect's URL resolves to nothing. No enum-literal filter
  // on kind: the value is compared in code, so this page also loads
  // cleanly against a database that predates migration 0072 (where no
  // deck draft can exist anyway).
  const { data: draft } = await supabase
    .from("drafts")
    .select("*")
    .eq("id", params.draftId)
    .eq("prospect_id", params.id)
    .maybeSingle<Draft>();
  if (!draft || draft.kind !== "deck") notFound();

  const { data: prospect } = await supabase
    .from("prospects")
    .select("name")
    .eq("id", params.id)
    .maybeSingle<{ name: string }>();
  const prospectName = prospect?.name ?? "this prospect";

  if (draft.status !== "approved") {
    // A plain message, never slides: the deck is what was approved, and
    // nothing has been.
    return (
      <main style={{ maxWidth: 560, margin: "0 auto", padding: spacing.xxl }}>
        <h1 style={{ fontSize: typeScale.sectionTitle }}>This deck outline is not approved yet</h1>
        <p style={{ fontSize: typeScale.body, color: colors.textMuted, marginTop: spacing.sm }}>
          The deck renders only from an approved outline, so what appears on the slides is exactly what a
          human signed off on. Review and approve the outline on the prospect&apos;s Strategy tab, then come
          back here.
        </p>
        <div style={{ marginTop: spacing.lg }}>
          <Link href={`/prospects/${params.id}?tab=strategy`} style={buttonSecondary}>
            Go to the outline for review
          </Link>
        </div>
      </main>
    );
  }

  const outline = parseDeckOutline(draft.content);

  // Footnote attributions resolve from the evidence library, read-only.
  // An id the library can't answer renders as explicitly unresolved --
  // never silently dropped, never invented.
  const { data: evidenceRows } =
    outline.evidenceIds.length > 0
      ? await supabase.from("evidence_items").select("id, title, type").in("id", outline.evidenceIds)
      : { data: [] as { id: string; title: string; type: string }[] };
  const evidenceById = new Map((evidenceRows ?? []).map((e) => [e.id, e]));

  return (
    <main style={{ background: colors.canvas }}>
      <style>{deckCss}</style>

      <div
        className="deck-screen-only"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: spacing.md,
          padding: `${spacing.md}px ${spacing.xl}px`,
          borderBottom: `1px solid ${colors.border}`,
          background: colors.bgSubtle,
        }}
      >
        <div style={{ fontSize: typeScale.meta, color: colors.textMuted }}>
          Approved deck for {prospectName} — use your browser&apos;s Print and choose &quot;Save as
          PDF&quot; for the exportable deck (one slide per page).
        </div>
        <Link href={`/prospects/${params.id}?tab=strategy`} style={{ ...buttonSecondary, padding: "6px 12px", fontSize: typeScale.meta, flexShrink: 0 }}>
          Back to prospect
        </Link>
      </div>

      {outline.slides.length === 0 && (
        <section className="deck-slide">
          <p style={{ fontSize: typeScale.bodyLg, color: colors.textMuted }}>
            The approved outline contains no slides. Add &quot;# &quot; title lines to it in the draft
            editor (its own header explains the format), re-approve, and this page will render them.
          </p>
        </section>
      )}

      {outline.slides.map((slide, i) => (
        <section key={i} className="deck-slide">
          {slide.title !== null && (
            <h2
              style={{
                fontSize: typeScale.display,
                lineHeight: 1.2,
                color: colors.navy900,
                margin: 0,
                marginBottom: slide.bullets.length > 0 ? spacing.xl : 0,
              }}
            >
              {slide.title}
            </h2>
          )}
          {slide.bullets.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 24, display: "grid", gap: spacing.md, maxWidth: 720 }}>
              {slide.bullets.map((bullet, j) => (
                <li key={j} style={{ fontSize: typeScale.bodyLg, lineHeight: 1.5, color: colors.text }}>
                  {bullet}
                </li>
              ))}
            </ul>
          )}
          {slide.evidenceIds.length > 0 && (
            <div
              style={{
                marginTop: "auto",
                paddingTop: spacing.lg,
                borderTop: `1px solid ${colors.border}`,
                display: "grid",
                gap: spacing.xs,
              }}
            >
              {slide.evidenceIds.map((id) => {
                const item = evidenceById.get(id);
                return (
                  <div key={id} style={{ fontSize: typeScale.meta, color: colors.textMuted }}>
                    {item
                      ? `Source: ${item.title} (${item.type}, evidence library)`
                      : `Source: evidence item ${id} — not found in the evidence library`}
                  </div>
                );
              })}
            </div>
          )}
          <div
            style={{
              marginTop: slide.evidenceIds.length > 0 ? spacing.sm : "auto",
              paddingTop: slide.evidenceIds.length > 0 ? 0 : spacing.lg,
              fontSize: 11,
              color: colors.textFaint,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>{prospectName}</span>
            <span>
              {i + 1} / {outline.slides.length}
            </span>
          </div>
        </section>
      ))}

      <div
        className="deck-screen-only"
        style={{
          padding: spacing.xl,
          textAlign: "center",
          fontSize: typeScale.meta,
          color: colors.textFaint,
          borderRadius: radiusSm,
        }}
      >
        Rendered exactly from the approved outline — no AI involved in this view.
      </div>
    </main>
  );
}
