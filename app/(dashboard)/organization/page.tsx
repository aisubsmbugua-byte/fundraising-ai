import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { saveOrgProfile } from "./actions";
import { ORG_TYPES, CAUSE_AREAS, GEO_SUGGESTIONS, orgTypeLabel, type OrgProfile, type Person } from "@/lib/organization";
import TagInput from "@/components/TagInput";
import ListInput from "@/components/ListInput";
import FunderInput from "@/components/FunderInput";
import PairRepeater from "@/components/PairRepeater";
import PersonInput from "@/components/PersonInput";
import CurrencyInput from "@/components/CurrencyInput";
import EnterAdvancesFocus from "@/components/EnterAdvancesFocus";
import SubmitButton from "@/components/SubmitButton";
import DocumentsModal from "./documents-modal";
import { spacing, colors, fieldStyle, labelStyle, sectionStyle, buttonSecondary } from "@/lib/ui";

const legendStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: colors.text, padding: "0 4px" };
const viewLabelStyle: React.CSSProperties = { fontSize: 12, color: colors.textMuted };

function ViewField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={viewLabelStyle}>{label}</div>
      <div style={{ whiteSpace: "pre-wrap" }}>{value || "—"}</div>
    </div>
  );
}

function ViewList({ label, items }: { label: string; items?: string[] | null }) {
  return (
    <div>
      <div style={viewLabelStyle}>{label}</div>
      {items && items.length > 0 ? (
        <ol style={{ margin: 0, paddingLeft: 20 }}>
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      ) : (
        <div>—</div>
      )}
    </div>
  );
}

function ViewPairs({
  label,
  items,
  keyA,
  keyB,
  keyBIsLink,
}: {
  label: string;
  items?: Record<string, string>[] | null;
  keyA: string;
  keyB: string;
  keyBIsLink?: boolean;
}) {
  return (
    <div>
      <div style={viewLabelStyle}>{label}</div>
      {items && items.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {items.map((item, i) => (
            <li key={i}>
              {item[keyA]}
              {item[keyB] &&
                (keyBIsLink ? (
                  <>
                    {" — "}
                    <a href={item[keyB]} target="_blank" rel="noopener noreferrer">
                      {item[keyB]}
                    </a>
                  </>
                ) : (
                  <span style={{ color: colors.textMuted }}> — {item[keyB]}</span>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <div>—</div>
      )}
    </div>
  );
}

function ViewPeople({ label, people }: { label: string; people?: Person[] | null }) {
  return (
    <div>
      <div style={viewLabelStyle}>{label}</div>
      {people && people.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {people.map((p, i) => (
            <li key={i}>
              {p.name}
              {p.role && <span style={{ color: colors.textMuted }}> — {p.role}</span>}
              {p.phone && <span style={{ color: colors.textMuted }}> · {p.phone}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div>—</div>
      )}
    </div>
  );
}

function ViewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={sectionStyle}>
      <div style={legendStyle}>{title}</div>
      {children}
    </div>
  );
}

function formatBudget(value: number | null) {
  return value ? `$${value.toLocaleString("en-US")}` : null;
}

export default async function OrganizationProfilePage({
  searchParams,
}: {
  searchParams: { saved?: string; edit?: string };
}) {
  const supabase = createClient();
  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle<OrgProfile>();

  const { data: documents } = await supabase
    .from("org_documents")
    .select("*")
    .order("uploaded_at", { ascending: false });

  const documentsWithUrls = await Promise.all(
    (documents ?? []).map(async (doc) => {
      const { data } = await supabase.storage.from("org-documents").createSignedUrl(doc.storage_path, 3600);
      return { ...doc, url: data?.signedUrl ?? null };
    })
  );

  const isEditing = searchParams.edit === "1" || !profile;

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Organization Profile</h1>
        <div style={{ display: "flex", gap: spacing.sm }}>
          <Link href="/organization/channel-fit" style={buttonSecondary}>
            Channel Fit
          </Link>
          <DocumentsModal documents={documentsWithUrls} />
          {!isEditing && (
            <Link href="/organization?edit=1" style={buttonSecondary}>
              Edit
            </Link>
          )}
        </div>
      </div>
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

      {isEditing ? (
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
            <label style={labelStyle}>
              Website
              <input
                name="website"
                type="text"
                placeholder="e.g. yournonprofit.org"
                defaultValue={profile?.website ?? ""}
                style={fieldStyle}
              />
            </label>
          </fieldset>

          <fieldset style={sectionStyle}>
            <legend style={legendStyle}>Key people</legend>
            <div>
              <span style={labelStyle}>Leadership (founder, executive director, board chair, etc.)</span>
              <div style={{ marginTop: spacing.xs }}>
                <PersonInput name="key_people" defaultValue={profile?.key_people ?? []} />
              </div>
            </div>
          </fieldset>

          <fieldset style={sectionStyle}>
            <legend style={legendStyle}>Online presence</legend>
            <div>
              <span style={labelStyle}>Social media links</span>
              <div style={{ marginTop: spacing.xs }}>
                <PairRepeater
                  name="social_links"
                  defaultValue={profile?.social_links ?? []}
                  keyA="platform"
                  keyB="url"
                  placeholderA="Platform (e.g. Instagram)"
                  placeholderB="URL"
                  widthA={1}
                  widthB={2}
                />
              </div>
            </div>
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
            <div>
              <span style={labelStyle}>
                Core values or guiding principles that shape how you work (faith tradition, community
                values, operating philosophy — whatever applies)
              </span>
              <div style={{ marginTop: spacing.xs }}>
                <ListInput
                  name="org_values"
                  defaultValue={profile?.org_values ?? []}
                  placeholder="Type a value, press Enter to add"
                />
              </div>
            </div>
          </fieldset>

          <fieldset style={sectionStyle}>
            <legend style={legendStyle}>Track record</legend>
            <div>
              <span style={labelStyle}>Key outcomes / impact metrics</span>
              <div style={{ marginTop: spacing.xs }}>
                <ListInput
                  name="outcomes"
                  defaultValue={profile?.outcomes ?? []}
                  placeholder="Type an outcome, press Enter to add"
                />
              </div>
            </div>
            <div>
              <span style={labelStyle}>Notable past or current funders</span>
              <div style={{ marginTop: spacing.xs }}>
                <FunderInput name="notable_funders" defaultValue={profile?.notable_funders ?? []} />
              </div>
            </div>
          </fieldset>

          <div style={{ display: "flex", gap: spacing.sm }}>
            <SubmitButton>Save Profile</SubmitButton>
            {profile && (
              <Link href="/organization" style={buttonSecondary}>
                Cancel
              </Link>
            )}
          </div>
        </form>
      ) : (
        <div style={{ display: "grid", gap: spacing.lg, marginTop: spacing.lg }}>
          <ViewSection title="Identity">
            <ViewField label="Organization name" value={profile?.name} />
            <ViewField
              label="Legal / tax status"
              value={profile?.org_type === "other" ? profile?.org_type_other : orgTypeLabel(profile?.org_type ?? null)}
            />
            <ViewField label="Year founded" value={profile?.year_founded} />
            <ViewField
              label="Website"
              value={
                profile?.website ? (
                  <a href={profile.website} target="_blank" rel="noopener noreferrer">
                    {profile.website}
                  </a>
                ) : null
              }
            />
          </ViewSection>

          <ViewSection title="Key people">
            <ViewPeople label="Leadership" people={profile?.key_people} />
          </ViewSection>

          <ViewSection title="Online presence">
            <ViewPairs
              label="Social media links"
              items={profile?.social_links}
              keyA="platform"
              keyB="url"
              keyBIsLink
            />
          </ViewSection>

          <ViewSection title="Financial">
            <ViewField label="Annual operating budget" value={formatBudget(profile?.annual_budget ?? null)} />
            <ViewField label="Current funding need or gap" value={profile?.funding_need} />
          </ViewSection>

          <ViewSection title="Mission & focus">
            <ViewField label="Problem statement" value={profile?.problem_statement} />
            <ViewField label="Mission statement" value={profile?.mission} />
            <ViewField label="Vision statement" value={profile?.vision} />
            <ViewField label="Programs" value={profile?.programs} />
            <ViewField
              label="Cause area(s)"
              value={[...(profile?.cause_areas ?? []), profile?.cause_area_other].filter(Boolean).join(", ")}
            />
          </ViewSection>

          <ViewSection title="Who & where">
            <ViewField label="Population(s) served" value={profile?.who_we_serve} />
            <ViewField label="Geographic area served" value={profile?.geographic_areas?.join(", ")} />
            <ViewField label="HQ location" value={profile?.hq_location} />
          </ViewSection>

          <ViewSection title="Values">
            <ViewList label="Core values or guiding principles" items={profile?.org_values} />
          </ViewSection>

          <ViewSection title="Track record">
            <ViewList label="Key outcomes / impact metrics" items={profile?.outcomes} />
            <ViewPairs label="Notable past or current funders" items={profile?.notable_funders} keyA="name" keyB="location" />
          </ViewSection>
        </div>
      )}
    </div>
  );
}
