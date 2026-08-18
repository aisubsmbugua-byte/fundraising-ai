import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProspect } from "../actions";
import { CHANNELS, channelLabel, stageLabel, type Prospect, type StageChange } from "@/lib/prospects";
import { tierLabel, type ScreeningResult } from "@/lib/screening";
import DeleteProspectButton from "./delete-button";
import ScreenButton from "./screen-button";
import TierBadge from "@/components/TierBadge";
import DeepDivePanel from "./deep-dive-panel";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";
import type { DeepDiveRun } from "@/lib/deep-dive";

const fieldLabelStyle: React.CSSProperties = { fontSize: 12, color: colors.textMuted };

export default async function ProspectDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { edit?: string };
}) {
  const supabase = createClient();
  const { data: prospect } = await supabase
    .from("prospects")
    .select("*")
    .eq("id", params.id)
    .single<Prospect>();

  if (!prospect) notFound();

  const { data: history } = await supabase
    .from("stage_changes")
    .select("*")
    .eq("prospect_id", prospect.id)
    .order("created_at", { ascending: false })
    .returns<StageChange[]>();

  const { data: screenings } = await supabase
    .from("screening_results")
    .select("*")
    .eq("prospect_id", prospect.id)
    .order("created_at", { ascending: false })
    .returns<ScreeningResult[]>();

  const latestScreening = screenings?.[0] ?? null;

  const { data: deepDiveRun } = await supabase
    .from("deep_dive_runs")
    .select("*")
    .eq("prospect_id", prospect.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<DeepDiveRun>();

  const isEditing = searchParams.edit === "1";
  const boundUpdate = updateProspect.bind(null, prospect.id);

  return (
    <div style={{ maxWidth: 480 }}>
      <Link href="/prospects" style={{ fontSize: 14, color: colors.textMuted, textDecoration: "none" }}>
        ← Back to Prospects
      </Link>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: spacing.sm,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1>{prospect.name}</h1>
          {latestScreening && <TierBadge tier={latestScreening.tier} />}
        </div>
        <div style={{ display: "flex", gap: spacing.sm }}>
          <ScreenButton prospectId={prospect.id} />
          {!isEditing && (
            <Link href={`/prospects/${prospect.id}?edit=1`} style={buttonSecondary}>
              Edit
            </Link>
          )}
          <DeleteProspectButton id={prospect.id} name={prospect.name} />
        </div>
      </div>

      {isEditing ? (
        <form action={boundUpdate} style={{ display: "grid", gap: spacing.md, marginTop: spacing.xl }}>
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
            <input
              name="contact_email"
              type="email"
              defaultValue={prospect.contact_email ?? ""}
              style={fieldStyle}
            />
          </label>
          <label style={labelStyle}>
            Website
            <input name="website" type="url" defaultValue={prospect.website ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Notes
            <textarea name="notes" rows={4} defaultValue={prospect.notes ?? ""} style={fieldStyle} />
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
        <dl style={{ marginTop: spacing.xl, display: "grid", gap: spacing.md }}>
          <div>
            <dt style={fieldLabelStyle}>Stage</dt>
            <dd>{stageLabel(prospect.stage)}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Channel</dt>
            <dd>{channelLabel(prospect.channel)}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Organization</dt>
            <dd>{prospect.organization ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Contact name</dt>
            <dd>{prospect.contact_name ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Contact email</dt>
            <dd>{prospect.contact_email ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Website</dt>
            <dd>{prospect.website ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Notes</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{prospect.notes ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Location</dt>
            <dd>{prospect.location ?? "— (from deep-dive research, once approved)"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Funder type</dt>
            <dd>{prospect.funder_type ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Geographic focus</dt>
            <dd>{prospect.geographic_focus ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Typical grant size</dt>
            <dd>{prospect.typical_grant_size ?? "—"}</dd>
          </div>
          <div>
            <dt style={fieldLabelStyle}>Focus areas</dt>
            <dd>{prospect.focus_areas?.join(", ") ?? "—"}</dd>
          </div>
        </dl>
      )}

      <div style={{ marginTop: spacing.xxl }}>
        <h2 style={{ fontSize: 16 }}>Stage History</h2>
        {history && history.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, marginTop: spacing.md, display: "grid", gap: spacing.sm }}>
            {history.map((h) => (
              <li key={h.id} style={{ fontSize: 13, borderBottom: `1px solid ${colors.bgSubtle}`, paddingBottom: spacing.sm }}>
                <strong>
                  {stageLabel(h.from_stage)} → {stageLabel(h.to_stage)}
                </strong>
                <div style={{ color: colors.textMuted, fontSize: 12 }}>
                  {h.changed_by_email} · {new Date(h.created_at).toLocaleString()}
                </div>
                {h.note && <div style={{ marginTop: spacing.xs }}>{h.note}</div>}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: colors.textFaint, fontSize: 13, marginTop: spacing.sm }}>No stage changes yet.</p>
        )}
      </div>

      <div style={{ marginTop: spacing.xxl }}>
        <h2 style={{ fontSize: 16 }}>Screening</h2>
        {latestScreening ? (
          <div style={{ marginTop: spacing.md }}>
            <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm }}>
              <TierBadge tier={latestScreening.tier} />
              <span style={{ fontSize: 12, color: colors.textMuted }}>
                {new Date(latestScreening.created_at).toLocaleString()}
              </span>
            </div>
            <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 6 }}>
              {latestScreening.breakdown.rules.map((r) => (
                <li key={r.rule_id} style={{ fontSize: 13, display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: r.passed ? colors.success : colors.textFaint }}>
                    {r.passed ? "✓" : "✗"} {r.label}
                  </span>
                  <span style={{ color: colors.textMuted }}>weight {r.weight}</span>
                </li>
              ))}
              {latestScreening.breakdown.rules.length === 0 && (
                <li style={{ fontSize: 13, color: colors.textFaint }}>
                  No active rules applied to this channel — defaulted to {tierLabel(latestScreening.tier)}.
                </li>
              )}
            </ul>
          </div>
        ) : (
          <p style={{ color: colors.textFaint, fontSize: 13, marginTop: spacing.sm }}>Not screened yet.</p>
        )}
      </div>

      <DeepDivePanel prospectId={prospect.id} initialRun={deepDiveRun ?? null} />
    </div>
  );
}
