import { createClient } from "@/lib/supabase/server";
import { saveOrgProfile } from "./actions";
import { ORG_TYPES, CAUSE_AREAS, GEO_SUGGESTIONS, type OrgProfile } from "@/lib/organization";
import TagInput from "@/components/TagInput";
import CurrencyInput from "@/components/CurrencyInput";
import EnterAdvancesFocus from "@/components/EnterAdvancesFocus";
import SubmitButton from "@/components/SubmitButton";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle } from "@/lib/ui";

const legendStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: colors.text, padding: "0 4px" };

export default async function OrganizationProfilePage({
  searchParams,
}: {
  searchParams: { saved?: string };
}) {
  const supabase = createClient();
  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Organization Profile</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        This is the nonprofit&apos;s own knowledge base — AI will use it to propose which funder types
        are a plausible match. The more specific, the better the suggestions.
      </p>
      {searchParams.saved === "1" && (
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
          ✓ Profile saved
        </div>
      )}

      <form action={saveOrgProfile} style={{ display: "grid", gap: spacing.lg, marginTop: spacing.lg }}>
        <EnterAdvancesFocus />
        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Identity</legend>
          <label style={labelStyle}>
            Organization name
            <input name="name" defaultValue={profile?.name ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Legal / tax status
            <select name="org_type" defaultValue={profile?.org_type ?? ""} style={fieldStyle}>
              <option value="">Select one</option>
              {ORG_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            If Other, describe
            <input name="org_type_other" defaultValue={profile?.org_type_other ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Year founded
            <input
              name="year_founded"
              type="number"
              defaultValue={profile?.year_founded ?? ""}
              style={fieldStyle}
            />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Financial</legend>
          <div>
            <span style={labelStyle}>Annual operating budget (USD)</span>
            <CurrencyInput name="annual_budget" defaultValue={profile?.annual_budget ?? null} />
          </div>
          <label style={labelStyle}>
            Current funding need or gap
            <textarea
              name="funding_need"
              rows={2}
              defaultValue={profile?.funding_need ?? ""}
              placeholder='e.g. "$150k general operating gap for FY26"'
              style={fieldStyle}
            />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Mission & focus</legend>
          <label style={labelStyle}>
            Problem statement — what problem do you exist to solve?
            <textarea
              name="problem_statement"
              rows={3}
              defaultValue={profile?.problem_statement ?? ""}
              style={fieldStyle}
            />
          </label>
          <label style={labelStyle}>
            Mission statement
            <textarea name="mission" rows={3} defaultValue={profile?.mission ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Vision statement
            <textarea name="vision" rows={3} defaultValue={profile?.vision ?? ""} style={fieldStyle} />
          </label>
          <label style={labelStyle}>
            Programs
            <textarea
              name="programs"
              rows={4}
              defaultValue={profile?.programs ?? ""}
              placeholder="What does the organization actually do? Programs, services, activities."
              style={fieldStyle}
            />
          </label>
          <div>
            <span style={labelStyle}>Cause area(s)</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.xs, marginTop: spacing.xs }}>
              {CAUSE_AREAS.map((area) => (
                <label key={area} style={{ display: "flex", alignItems: "center", gap: spacing.xs, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    name="cause_areas"
                    value={area}
                    defaultChecked={profile?.cause_areas?.includes(area) ?? false}
                  />
                  {area}
                </label>
              ))}
            </div>
            <input
              name="cause_area_other"
              placeholder="Other cause area"
              defaultValue={profile?.cause_area_other ?? ""}
              style={{ ...fieldStyle, marginTop: spacing.sm }}
            />
          </div>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Who & where</legend>
          <label style={labelStyle}>
            Population(s) served
            <textarea
              name="who_we_serve"
              rows={2}
              defaultValue={profile?.who_we_serve ?? ""}
              style={fieldStyle}
            />
          </label>
          <div>
            <span style={labelStyle}>Geographic area served</span>
            <div style={{ marginTop: spacing.xs }}>
              <TagInput
                name="geographic_areas"
                defaultValue={profile?.geographic_areas ?? []}
                suggestions={[...GEO_SUGGESTIONS]}
                placeholder="Type a place, press Enter to add"
              />
            </div>
          </div>
          <label style={labelStyle}>
            HQ location
            <input name="hq_location" defaultValue={profile?.hq_location ?? ""} style={fieldStyle} />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Values</legend>
          <label style={labelStyle}>
            Core values or guiding principles that shape how you work (faith tradition, community
            values, operating philosophy — whatever applies)
            <textarea name="org_values" rows={3} defaultValue={profile?.org_values ?? ""} style={fieldStyle} />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Track record</legend>
          <label style={labelStyle}>
            Key outcomes / impact metrics
            <textarea name="outcomes" rows={3} defaultValue={profile?.outcomes ?? ""} style={fieldStyle} />
          </label>
          <div>
            <span style={labelStyle}>Notable past or current funders</span>
            <div style={{ marginTop: spacing.xs }}>
              <TagInput
                name="notable_funders"
                defaultValue={profile?.notable_funders ?? []}
                placeholder="Type a funder name, press Enter to add"
              />
            </div>
          </div>
        </fieldset>

        <SubmitButton>Save Profile</SubmitButton>
      </form>
    </div>
  );
}
