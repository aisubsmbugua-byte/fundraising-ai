import Link from "next/link";
import { Pencil } from "lucide-react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProspect } from "../actions";
import { CHANNELS, channelLabel, stageLabel, STAGES, type Prospect, type StageChange } from "@/lib/prospects";
import { screenProspect, type ScreeningRule, type ScreeningResult } from "@/lib/screening";
import DeleteProspectButton from "./delete-button";
import ScreenButton from "./screen-button";
import AdvanceStageButton from "./advance-stage-button";
import MoveStageControl from "@/app/(dashboard)/pipeline/move-stage-control";
import RightRail from "./right-rail";
import OverviewTab from "./overview-tab";
import ResearchTab from "./research-tab";
import { loadProspectIntelligence } from "@/lib/prospect-intelligence";
import { loadProspectWorkflow } from "@/lib/prospect-workflow";
import ActivityTab from "./activity-tab";
import ContactsTab from "./contacts-tab";
import StrategyPanel from "./strategy-panel";
import DraftPanel from "./draft-panel";
import FitScoreCircle from "@/components/FitScoreCircle";
import InitialsAvatar from "@/components/InitialsAvatar";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, chipStyle, sectionStyle } from "@/lib/ui";
import type { StrategyRun } from "@/lib/strategy";
import type { Draft } from "@/lib/drafts";
import type { Contact } from "@/lib/contacts";

// Strategy generation runs two sequential AI calls with real web search,
// can run past the Vercel Pro default (60s) -- give this route real
// headroom instead of racing the clock.
export const maxDuration = 280;

const MS_PER_DAY = 86400000;
const TABS = [
  { value: "overview", label: "Overview" },
  { value: "research", label: "Research" },
  { value: "strategy", label: "Strategy" },
  { value: "activity", label: "Activity" },
  { value: "contacts", label: "Contacts" },
] as const;

export default async function ProspectDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { edit?: string; tab?: string };
}) {
  const supabase = createClient();
  const { data: prospect } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", params.id)
    .single<Prospect>();

  if (!prospect) notFound();

  // Workflow state covers runs still in flight, which loadProspectIntelligence
  // deliberately cannot see (it only reads finished ones) -- so both are
  // needed, and neither is derivable from the other.
  const [intelligence, workflow] = await Promise.all([
    loadProspectIntelligence(supabase, prospect.id),
    loadProspectWorkflow(supabase, prospect.id),
  ]);

  const [
    { data: history },
    { data: screenings },
    { data: strategyRun },
    { data: drafts },
    { data: rulesData },
    { data: relatedContacts },
  ] = await Promise.all([
    supabase
      .from("stage_changes")
      .select("*")
      .eq("prospect_id", prospect.id)
      .order("created_at", { ascending: false })
      .returns<StageChange[]>(),
    supabase
      .from("screening_results")
      .select("*")
      .eq("prospect_id", prospect.id)
      .order("created_at", { ascending: false })
      .returns<ScreeningResult[]>(),
    supabase
      .from("strategy_runs")
      .select("*")
      .eq("prospect_id", prospect.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<StrategyRun>(),
    supabase.from("drafts").select("*").eq("prospect_id", prospect.id).order("created_at", { ascending: false }).returns<Draft[]>(),
    supabase.from("screening_rules").select("*").eq("active", true),
    supabase.from("contacts").select("*").eq("source_prospect_id", prospect.id).returns<Contact[]>(),
  ]);

  const latestScreening = screenings?.[0] ?? null;
  const rules = (rulesData ?? []) as ScreeningRule[];
  const fitPercentage = screenProspect(prospect, rules).breakdown.percentage;

  const stageIndex = STAGES.findIndex((s) => s.value === prospect.stage);
  const nextStage = STAGES[stageIndex + 1];
  const latestChangeIntoCurrentStage = (history ?? []).find((h) => h.to_stage === prospect.stage);
  const stageEnteredAt = latestChangeIntoCurrentStage?.created_at ?? prospect.created_at;
  const daysInStage = (Date.now() - new Date(stageEnteredAt).getTime()) / MS_PER_DAY;

  const isEditing = searchParams.edit === "1";
  const activeTab = TABS.some((t) => t.value === searchParams.tab) ? searchParams.tab! : "overview";
  const boundUpdate = updateProspect.bind(null, prospect.id);

  return (
    <div>
      <Link href="/pipeline?view=list" style={{ fontSize: 13, color: colors.textMuted, textDecoration: "none" }}>
        Pipeline / {stageLabel(prospect.stage)}
      </Link>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: spacing.sm, gap: spacing.lg, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: spacing.md, minWidth: 0 }}>
          <InitialsAvatar name={prospect.name} />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 24 }}>{prospect.name}</h1>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
              {channelLabel(prospect.channel)}
              {prospect.location ? ` · ${prospect.location}` : ""}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs, flexWrap: "wrap" }}>
              <span style={chipStyle("neutral")}>{stageLabel(prospect.stage)}</span>
              {fitPercentage != null && (
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: colors.textMuted }}>
                  <FitScoreCircle percentage={fitPercentage} size={20} /> {Math.round(fitPercentage * 100)}% match
                </span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "center" }}>
          <ScreenButton prospectId={prospect.id} />
          {!isEditing && (
            <Link
              href={`/prospects/${prospect.id}?edit=1`}
              style={{ ...buttonSecondary, display: "flex", alignItems: "center", gap: 8 }}
            >
              <Pencil size={14} /> Edit
            </Link>
          )}
          <DeleteProspectButton id={prospect.id} name={prospect.name} />
          {nextStage && (
            <AdvanceStageButton prospectId={prospect.id} currentStage={prospect.stage} nextStage={nextStage.value} />
          )}
        </div>
      </div>

      {/* Identity doubt belongs where progression happens, not only inside the
          Research tab -- a user acting from the header would otherwise never
          see it. Deliberately a warning and not a block: the pipeline gate is
          a HUMAN decision, and a fundraiser may well know which foundation
          this is when our resolver could not tell from search results.
          Automated consumers (Strategy) are gated separately and strictly. */}
      {/* Two different situations, and telling them apart is the whole point:
          nobody has said who this is, versus somebody has and the research
          predates it. The second used to render as the first, so a person who
          had just confirmed the entity was told their work had not happened. */}
      {intelligence?.state === "blocked" && (
        <div
          style={{
            marginTop: spacing.md,
            padding: spacing.sm,
            border: `1px solid ${prospect.ein ? "#b8860b" : colors.danger}`,
            borderRadius: 6,
            fontSize: 13,
            color: colors.text,
          }}
        >
          {prospect.ein ? (
            <>
              <strong>Research is out of date.</strong> You confirmed this organization as {prospect.ein} after this
              research ran, so its findings may still describe a different one.{" "}
              <Link href={`/prospects/${prospect.id}?tab=research`} style={{ color: "#8a6508" }}>
                Run research again
              </Link>{" "}
              and it will resolve to that EIN directly.
            </>
          ) : (
            <>
              <strong>Identity not confirmed.</strong> Research found more than one organization matching this name and
              could not tell which is meant, so its findings may describe a different one.{" "}
              <Link href={`/prospects/${prospect.id}?tab=research`} style={{ color: colors.danger }}>
                Confirm the entity in Research
              </Link>{" "}
              before relying on this research or generating a strategy from it.
            </>
          )}
        </div>
      )}

      {isEditing ? (
        <form action={boundUpdate} style={{ display: "grid", gap: spacing.md, marginTop: spacing.xl, maxWidth: 480 }}>
          <label style={labelStyle}>
            Name *
            <input name="name" defaultValue={prospect.name} required style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Channel *
            <select name="channel" defaultValue={prospect.channel} required style={fieldStyle}>
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Organization
            <input name="organization" defaultValue={prospect.organization ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Contact name
            <input name="contact_name" defaultValue={prospect.contact_name ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Contact email
            <input name="contact_email" type="email" defaultValue={prospect.contact_email ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Website
            <input name="website" type="url" defaultValue={prospect.website ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Legal name
            <input name="legal_name" defaultValue={prospect.legal_name ?? ""} placeholder="If different from the name above" style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            EIN
            <input name="ein" defaultValue={prospect.ein ?? ""} placeholder="e.g. 62-6041468" style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Notes
            <textarea name="notes" rows={4} defaultValue={prospect.notes ?? ""} style={fieldStyle} />
          </label>

          <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginTop: spacing.sm }}>
            Pipeline tracking
          </div>
          <label style={labelStyle}>
            Ask amount
            <input name="ask_amount" type="number" min={0} step={1} defaultValue={prospect.ask_amount ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Next action
            <input name="next_action" defaultValue={prospect.next_action ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Next action due
            <input name="next_action_due" type="date" defaultValue={prospect.next_action_due ?? ""} style={fieldStyle} />
          </label>

          <div style={{ fontSize: 13, fontWeight: 600, color: colors.text, marginTop: spacing.sm }}>
            Funder intelligence
          </div>
          <label style={labelStyle}>
            Location
            <input name="location" defaultValue={prospect.location ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Funder type
            <input name="funder_type" defaultValue={prospect.funder_type ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Geographic focus
            <input name="geographic_focus" defaultValue={prospect.geographic_focus ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Typical grant size
            <input name="typical_grant_size" defaultValue={prospect.typical_grant_size ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Focus areas (comma-separated)
            <input name="focus_areas" defaultValue={prospect.focus_areas?.join(", ") ?? ""} style={fieldStyle} />
          </label>

          <div style={{ display: "flex", gap: spacing.sm }}>
            <button type="submit" style={buttonPrimary}>
              Save Changes
            </button>
            <Link href={`/prospects/${prospect.id}`} style={buttonSecondary}>
              Cancel
            </Link>
          </div>
        </form>
      ) : (
        <>
          <div style={{ display: "flex", gap: spacing.lg, marginTop: spacing.xl, borderBottom: `1px solid ${colors.border}` }}>
            {TABS.map((t) => (
              <Link
                key={t.value}
                href={`/prospects/${prospect.id}?tab=${t.value}`}
                style={{
                  fontSize: 14,
                  fontWeight: activeTab === t.value ? 600 : 500,
                  color: activeTab === t.value ? colors.text : colors.textMuted,
                  textDecoration: "none",
                  padding: "8px 2px",
                  borderBottom: `2px solid ${activeTab === t.value ? colors.primary : "transparent"}`,
                }}
              >
                {t.label}
              </Link>
            ))}
          </div>

          <div className="responsive-grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: spacing.xl, marginTop: spacing.xl }}>
            <div style={{ minWidth: 0 }}>
              {activeTab === "overview" && (
                <OverviewTab
                  prospect={prospect}
                  daysInStage={daysInStage}
                  latestScreening={latestScreening}
                  strategyRun={strategyRun ?? null}
                  recentHistory={(history ?? []).slice(0, 3)}
                />
              )}
              {activeTab === "research" && (
                <ResearchTab
                  prospectId={prospect.id}
                  intelligence={intelligence}
                  strategyRun={strategyRun ?? null}
                  workflow={workflow}
                  lastCompletedAt={workflow.lastCompletedAt}
                  approvedClaimCount={workflow.approvedClaimCount}
                  prospectEin={prospect.ein}
                />
              )}
              {activeTab === "strategy" && strategyRun?.strategy && !strategyRun.approved_intelligence_run_id && (
                <div
                  style={{
                    padding: spacing.sm,
                    border: `1px solid ${colors.border}`,
                    borderLeft: `3px solid #b8860b`,
                    borderRadius: 6,
                    fontSize: 12.5,
                    color: colors.textMuted,
                    marginBottom: spacing.md,
                  }}
                >
                  Created from legacy research. This strategy has not been checked against approved Prospect
                  Intelligence — regenerate it once the research below is reviewed and approved.
                </div>
              )}
              {activeTab === "strategy" && (
                <>
                  <MoveStageControl prospectId={prospect.id} prospectName={prospect.name} currentStage={prospect.stage} />
                  <div style={{ marginTop: spacing.lg }}>
                    {strategyRun ? (
                      <StrategyPanel prospectId={prospect.id} initialRun={strategyRun} />
                    ) : (
                      // A strategy is generated from approved intelligence, so
                      // an empty Strategy tab has a cause, and it is always on
                      // the Research tab. Saying which step is outstanding
                      // beats an empty panel that looks broken.
                      <div style={sectionStyle}>
                        <h3 style={{ fontSize: 14, margin: 0 }}>No strategy yet</h3>
                        <p style={{ fontSize: 13, color: colors.textMuted, marginTop: spacing.xs, marginBottom: 0 }}>
                          A strategy is written from research you have reviewed and approved. {workflow.hint}{" "}
                          <Link href={`/prospects/${prospect.id}?tab=research`} style={{ color: colors.text }}>
                            Go to Research
                          </Link>
                          .
                        </p>
                      </div>
                    )}
                  </div>
                  {strategyRun?.approved_strategy && (
                    <DraftPanel prospectId={prospect.id} strategyRunId={strategyRun.id} drafts={drafts ?? []} />
                  )}
                </>
              )}
              {activeTab === "activity" && <ActivityTab history={history ?? []} />}
              {activeTab === "contacts" && <ContactsTab prospect={prospect} relatedContacts={relatedContacts ?? []} />}
            </div>
            <RightRail prospect={prospect} />
          </div>
        </>
      )}
    </div>
  );
}
