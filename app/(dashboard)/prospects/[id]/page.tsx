import Link from "next/link";
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
import ActivityTab from "./activity-tab";
import ContactsTab from "./contacts-tab";
import DeepDivePanel from "./deep-dive-panel";
import DraftPanel from "./draft-panel";
import FitScoreCircle from "@/components/FitScoreCircle";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, chipStyle } from "@/lib/ui";
import type { DeepDiveRun } from "@/lib/deep-dive";
import type { Draft } from "@/lib/drafts";
import type { Contact } from "@/lib/contacts";

// Deep dive runs two sequential AI calls with real web search, which
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

  const [
    { data: history },
    { data: screenings },
    { data: deepDiveRun },
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
      .from("deep_dive_runs")
      .select("*")
      .eq("prospect_id", prospect.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<DeepDiveRun>(),
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

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: spacing.sm, gap: spacing.lg }}>
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
        <div style={{ display: "flex", gap: spacing.sm, flexShrink: 0, alignItems: "center" }}>
          <ScreenButton prospectId={prospect.id} />
          {!isEditing && (
            <Link href={`/prospects/${prospect.id}?edit=1`} style={buttonSecondary}>
              Edit
            </Link>
          )}
          <DeleteProspectButton id={prospect.id} name={prospect.name} />
          {nextStage && (
            <AdvanceStageButton prospectId={prospect.id} currentStage={prospect.stage} nextStage={nextStage.value} />
          )}
        </div>
      </div>

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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: spacing.xl, marginTop: spacing.xl }}>
            <div style={{ minWidth: 0 }}>
              {activeTab === "overview" && (
                <OverviewTab
                  prospect={prospect}
                  daysInStage={daysInStage}
                  latestScreening={latestScreening}
                  deepDiveRun={deepDiveRun ?? null}
                  recentHistory={(history ?? []).slice(0, 3)}
                />
              )}
              {activeTab === "research" && <ResearchTab deepDiveRun={deepDiveRun ?? null} />}
              {activeTab === "strategy" && (
                <>
                  <MoveStageControl prospectId={prospect.id} prospectName={prospect.name} currentStage={prospect.stage} />
                  <div style={{ marginTop: spacing.lg }}>
                    <DeepDivePanel prospectId={prospect.id} initialRun={deepDiveRun ?? null} />
                  </div>
                  {deepDiveRun?.approved_strategy && (
                    <DraftPanel prospectId={prospect.id} deepDiveRunId={deepDiveRun.id} drafts={drafts ?? []} />
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

function InitialsAvatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: "50%",
        background: colors.navy900,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: 15,
        flexShrink: 0,
      }}
    >
      {initials || "?"}
    </div>
  );
}
