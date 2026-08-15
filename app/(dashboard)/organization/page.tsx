import { createClient } from "@/lib/supabase/server";
import { saveOrgProfile } from "./actions";
import { ORG_TYPES, CAUSE_AREAS, type OrgProfile } from "@/lib/organization";

const sectionStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: 16,
  display: "grid",
  gap: 12,
};

const legendStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: "#334155", padding: "0 4px" };

const inputStyle: React.CSSProperties = { width: "100%", padding: 8, marginTop: 4 };

export default async function OrganizationProfilePage() {
  const supabase = createClient();
  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

  return (
    <div style={{ maxWidth: 640 }}>
      <h1>Organization Profile</h1>
      <p style={{ color: "#64748b", fontSize: 14 }}>
        This is the nonprofit&apos;s own knowledge base — AI will use it to propose which funder types
        are a plausible match. The more specific, the better the suggestions.
      </p>

      <form action={saveOrgProfile} style={{ display: "grid", gap: 16, marginTop: 16 }}>
        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Identity</legend>
          <label>
            Organization name
            <input name="name" defaultValue={profile?.name ?? ""} style={inputStyle} />
          </label>
          <label>
            Legal / tax status
            <select name="org_type" defaultValue={profile?.org_type ?? ""} style={inputStyle}>
              <option value="">Select one</option>
              {ORG_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            If Other, describe
            <input name="org_type_other" defaultValue={profile?.org_type_other ?? ""} style={inputStyle} />
          </label>
          <label>
            Year founded
            <input
              name="year_founded"
              type="number"
              defaultValue={profile?.year_founded ?? ""}
              style={inputStyle}
            />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Financial</legend>
          <label>
            Annual operating budget (USD)
            <input
              name="annual_budget"
              type="number"
              defaultValue={profile?.annual_budget ?? ""}
              style={inputStyle}
            />
          </label>
          <label>
            Current funding need or gap
            <textarea
              name="funding_need"
              rows={2}
              defaultValue={profile?.funding_need ?? ""}
              placeholder='e.g. "$150k general operating gap for FY26"'
              style={inputStyle}
            />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Mission & focus</legend>
          <label>
            Problem statement — what problem do you exist to solve?
            <textarea
              name="problem_statement"
              rows={3}
              defaultValue={profile?.problem_statement ?? ""}
              style={inputStyle}
            />
          </label>
          <label>
            Mission statement
            <textarea name="mission" rows={3} defaultValue={profile?.mission ?? ""} style={inputStyle} />
          </label>
          <label>
            Vision statement
            <textarea name="vision" rows={3} defaultValue={profile?.vision ?? ""} style={inputStyle} />
          </label>
          <label>
            Programs
            <textarea
              name="programs"
              rows={4}
              defaultValue={profile?.programs ?? ""}
              placeholder="What does the organization actually do? Programs, services, activities."
              style={inputStyle}
            />
          </label>
          <div>
            <span style={{ fontSize: 14 }}>Cause area(s)</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 4 }}>
              {CAUSE_AREAS.map((area) => (
                <label key={area} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
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
              style={{ ...inputStyle, marginTop: 8 }}
            />
          </div>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Who & where</legend>
          <label>
            Population(s) served
            <textarea
              name="who_we_serve"
              rows={2}
              defaultValue={profile?.who_we_serve ?? ""}
              style={inputStyle}
            />
          </label>
          <label>
            Geographic area served
            <input
              name="geographic_area"
              defaultValue={profile?.geographic_area ?? ""}
              placeholder="e.g. city, state, national, international"
              style={inputStyle}
            />
          </label>
          <label>
            HQ location
            <input name="hq_location" defaultValue={profile?.hq_location ?? ""} style={inputStyle} />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Values</legend>
          <label>
            Core values or guiding principles that shape how you work (faith tradition, community
            values, operating philosophy — whatever applies)
            <textarea name="org_values" rows={3} defaultValue={profile?.org_values ?? ""} style={inputStyle} />
          </label>
        </fieldset>

        <fieldset style={sectionStyle}>
          <legend style={legendStyle}>Track record</legend>
          <label>
            Key outcomes / impact metrics
            <textarea name="outcomes" rows={3} defaultValue={profile?.outcomes ?? ""} style={inputStyle} />
          </label>
          <label>
            Notable past or current funders
            <textarea
              name="notable_funders"
              rows={2}
              defaultValue={profile?.notable_funders ?? ""}
              style={inputStyle}
            />
          </label>
        </fieldset>

        <button
          type="submit"
          style={{ padding: 10, background: "#0f172a", color: "#fff", border: "none", borderRadius: 6 }}
        >
          Save Profile
        </button>
      </form>
    </div>
  );
}
