import { createClient } from "@/lib/supabase/server";
import { saveOrgProfile } from "./actions";

export default async function OrganizationProfilePage() {
  const supabase = createClient();
  const { data: profile } = await supabase.from("org_profile").select("*").limit(1).maybeSingle();

  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Organization Profile</h1>
      <p style={{ color: "#64748b", fontSize: 14 }}>
        This is the nonprofit&apos;s own knowledge base — AI will use it to propose which funder types
        are a plausible match. The more specific, the better the suggestions.
      </p>
      <form action={saveOrgProfile} style={{ display: "grid", gap: 12, marginTop: 16 }}>
        <label>
          Mission
          <textarea
            name="mission"
            rows={3}
            defaultValue={profile?.mission ?? ""}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label>
          Programs
          <textarea
            name="programs"
            rows={4}
            defaultValue={profile?.programs ?? ""}
            placeholder="What does the organization actually do? Programs, services, activities."
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label>
          Who we serve
          <textarea
            name="who_we_serve"
            rows={3}
            defaultValue={profile?.who_we_serve ?? ""}
            style={{ width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
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
