import Link from "next/link";
import {
  Building2,
  Users,
  DollarSign,
  Target,
  MapPin,
  Heart,
  TrendingUp,
  FileText,
  CircleCheck,
  CircleAlert,
  Pencil,
  ArrowUpRight,
  Sparkles,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { saveOrgProfile } from "./actions";
import {
  ORG_TYPES,
  CAUSE_AREAS,
  GEO_SUGGESTIONS,
  orgTypeLabel,
  computeProfileHealth,
  computeProfileCompleteness,
  type OrgProfile,
  type Person,
} from "@/lib/organization";
import TagInput from "@/components/TagInput";
import ListInput from "@/components/ListInput";
import FunderInput from "@/components/FunderInput";
import PairRepeater from "@/components/PairRepeater";
import PersonInput from "@/components/PersonInput";
import CurrencyInput from "@/components/CurrencyInput";
import EnterAdvancesFocus from "@/components/EnterAdvancesFocus";
import SubmitButton from "@/components/SubmitButton";
import DocumentsModal from "./documents-modal";
import InitialsAvatar from "@/components/InitialsAvatar";
import FitScoreCircle from "@/components/FitScoreCircle";
import { spacing, colors, type as typeScale, radiusSm, fieldStyle, labelStyle, sectionStyle, cardStyle, chipStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

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
                    <a href={item[keyB]} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: "break-word" }}>
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

function IconTitle({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: radiusSm,
          background: colors.teal100,
          color: colors.teal700,
          flexShrink: 0,
        }}
      >
        <Icon size={15} />
      </span>
      <span style={{ fontSize: typeScale.cardTitle, fontWeight: 600 }}>{title}</span>
    </div>
  );
}

function Chips({ items }: { items: string[] }) {
  if (items.length === 0) return <div>—</div>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.xs }}>
      {items.map((item) => (
        <span key={item} style={chipStyle("neutral")}>
          {item}
        </span>
      ))}
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
  const completeness = computeProfileCompleteness(profile ?? null);
  const health = computeProfileHealth(profile ?? null);
  const recentDocuments = documentsWithUrls.slice(0, 3);

  return (
    <div style={{ maxWidth: isEditing ? 640 : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md }}>
        <div>
          <h1 style={{ fontSize: typeScale.pageTitle }}>Organization Profile</h1>
          <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
            This is the nonprofit&apos;s own knowledge base — AI will use it to propose which funder
            types are a plausible match. The more specific, the better the suggestions.
          </p>
        </div>
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
          <DocumentsModal documents={documentsWithUrls} />
          {!isEditing && (
            <Link
              href="/organization?edit=1"
              style={{ ...buttonPrimary, display: "flex", alignItems: "center", gap: 8, textDecoration: "none" }}
            >
              <Pencil size={15} /> Edit Profile
            </Link>
          )}
        </div>
      </div>
      {searchParams.saved === "1" && (
        <div style={{ ...chipStyle("teal"), marginTop: spacing.sm, fontSize: 13, padding: "6px 12px" }}>
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
        <div className="responsive-grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: spacing.xl, marginTop: spacing.xl, alignItems: "start" }}>
          <div style={{ display: "grid", gap: spacing.lg, minWidth: 0 }}>
            <div style={sectionStyle}>
              <IconTitle icon={Building2} title="Organization snapshot" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.md }}>
                <ViewField label="Organization name" value={profile?.name} />
                <ViewField
                  label="Legal / tax status"
                  value={
                    profile?.org_type === "other" ? profile?.org_type_other : orgTypeLabel(profile?.org_type ?? null)
                  }
                />
                <ViewField label="Year founded" value={profile?.year_founded} />
                <ViewField
                  label="Website"
                  value={
                    profile?.website ? (
                      <a href={profile.website} target="_blank" rel="noopener noreferrer" style={{ overflowWrap: "break-word" }}>
                        {profile.website}
                      </a>
                    ) : null
                  }
                />
                <ViewField label="Annual operating budget" value={formatBudget(profile?.annual_budget ?? null)} />
                <ViewField label="Current funding need or gap" value={profile?.funding_need} />
              </div>
            </div>

            <div style={sectionStyle}>
              <IconTitle icon={Target} title="Mission and focus" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.md }}>
                <ViewField label="Problem statement" value={profile?.problem_statement} />
                <ViewField label="Mission statement" value={profile?.mission} />
                <ViewField label="Vision statement" value={profile?.vision} />
                <ViewField label="Programs" value={profile?.programs} />
              </div>
              <div>
                <div style={viewLabelStyle}>Cause area(s)</div>
                <Chips items={[...(profile?.cause_areas ?? []), profile?.cause_area_other].filter((v): v is string => !!v)} />
              </div>
            </div>

            <div style={sectionStyle}>
              <IconTitle icon={MapPin} title="Who and where" />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: spacing.md }}>
                <ViewField label="Population(s) served" value={profile?.who_we_serve} />
                <ViewField label="HQ location" value={profile?.hq_location} />
              </div>
              <div>
                <div style={viewLabelStyle}>Geographic area served</div>
                <Chips items={profile?.geographic_areas ?? []} />
              </div>
            </div>

            <div style={sectionStyle}>
              <IconTitle icon={Heart} title="Values and track record" />
              <div>
                <div style={viewLabelStyle}>Core values or guiding principles</div>
                <Chips items={profile?.org_values ?? []} />
              </div>
              <ViewList label="Key outcomes / impact metrics" items={profile?.outcomes} />
              <ViewPairs
                label="Notable past or current funders"
                items={profile?.notable_funders}
                keyA="name"
                keyB="location"
              />
            </div>

            <div style={sectionStyle}>
              <IconTitle icon={Share2} title="Online presence" />
              <ViewPairs
                label="Social media links"
                items={profile?.social_links}
                keyA="platform"
                keyB="url"
                keyBIsLink
              />
            </div>
          </div>

          <div style={{ display: "grid", gap: spacing.lg, minWidth: 0 }}>
            <div style={sectionStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: spacing.lg }}>
                <FitScoreCircle percentage={completeness} size={64} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Profile complete</div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                    Used in Channel Fit analysis and Donor Finder search
                  </div>
                </div>
              </div>
              <Link
                href="/organization/channel-fit"
                style={{
                  ...buttonSecondary,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Sparkles size={15} /> View Channel Fit <ArrowUpRight size={13} />
              </Link>
            </div>

            <div style={sectionStyle}>
              <IconTitle icon={CircleCheck} title="Profile health" />
              <div style={{ display: "grid", gap: spacing.sm }}>
                {health.map((section) => (
                  <div key={section.key} style={{ display: "flex", alignItems: "center", gap: spacing.sm, fontSize: 13 }}>
                    {section.complete ? (
                      <CircleCheck size={15} color={colors.teal700} style={{ flexShrink: 0 }} />
                    ) : (
                      <CircleAlert size={15} color={colors.amber700} style={{ flexShrink: 0 }} />
                    )}
                    <span style={{ flex: 1 }}>{section.label}</span>
                    <span style={{ color: section.complete ? colors.teal700 : colors.amber700, fontSize: 12, fontWeight: 600 }}>
                      {section.complete ? "Complete" : "Needs attention"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div style={sectionStyle}>
              <IconTitle icon={Users} title="Key people" />
              {profile?.key_people?.length ? (
                <div style={{ display: "grid", gap: spacing.sm }}>
                  {profile.key_people.map((p, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
                      <InitialsAvatar name={p.name} size={32} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</div>
                        <div style={{ fontSize: 12, color: colors.textMuted }}>
                          {[p.role, p.phone].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>No key people on file yet.</p>
              )}
            </div>

            <div style={sectionStyle}>
              <IconTitle icon={FileText} title="Recent documents" />
              {recentDocuments.length > 0 ? (
                <div style={{ display: "grid", gap: spacing.sm }}>
                  {recentDocuments.map((doc) => (
                    <div key={doc.id} style={cardStyle}>
                      {doc.url ? (
                        <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>
                          {doc.file_name}
                        </a>
                      ) : (
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{doc.file_name}</span>
                      )}
                      <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                        Uploaded {new Date(doc.uploaded_at).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ fontSize: 13, color: colors.textFaint, margin: 0 }}>No documents uploaded yet.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
