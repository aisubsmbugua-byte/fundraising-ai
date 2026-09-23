"use server";

// Logo upload/remove for the Org Settings page (STATE item 71, part a).
// Same shape as documents/actions.ts's uploadOrgDocument/deleteOrgDocument
// -- storage upload/remove plus a metadata write -- with two differences
// that follow from what a logo is, not a general-purpose document:
//
//   Bucket is 'org-logos', PUBLIC (migration 0073), not 'org-documents'
//   (private + signed URLs). See that migration for the reasoning: the
//   proposal render view needs the browser to load the logo directly via
//   <img src>, including at print time, and a logo carries none of the
//   confidentiality an uploaded org document might.
//
//   There is no separate org_logos table -- logo_path is a single column
//   on the org_profile singleton (mirroring how primary_color/
//   accent_color live there too), so this reads/writes that one row
//   instead of inserting a new metadata row per upload. Uploading a new
//   logo replaces the old one: the previous object is removed from
//   storage so an old logo never lingers as an orphaned public file.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const MAX_LOGO_SIZE = 5 * 1024 * 1024; // 5MB -- a logo, not a document
const ALLOWED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/svg+xml", "image/webp"]);

export async function uploadOrgLogo(formData: FormData): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) return { error: "Choose an image file to upload." };
  if (file.size > MAX_LOGO_SIZE) return { error: "Logo file is too large (5MB max)." };
  if (file.type && !ALLOWED_LOGO_TYPES.has(file.type)) {
    return { error: "Logo must be a PNG, JPEG, SVG, or WebP image." };
  }

  // Prefixed with the org's own id because the org-logos bucket's
  // storage.objects RLS policies check that prefix (migration 0073, same
  // pattern as org-documents in 0034) -- storage keys have no DB-level
  // default to lean on, so this is built explicitly, same as
  // uploadOrgDocument.
  const { data: profile } = await supabase.from("profiles").select("organization_id").eq("id", user.id).single();
  if (!profile) return { error: "No organization found for your account." };
  const path = `${profile.organization_id}/${crypto.randomUUID()}-${file.name}`;

  const { error: uploadError } = await supabase.storage.from("org-logos").upload(path, file);
  if (uploadError) return { error: uploadError.message };

  // org_profile is a singleton (same enforcement-in-app-code as
  // saveOrgProfile): update the existing row's logo_path, or insert a new
  // row if a logo is uploaded before the profile has ever been saved.
  const { data: existing } = await supabase.from("org_profile").select("id, logo_path").limit(1).maybeSingle();

  const { error: writeError } = existing
    ? await supabase
        .from("org_profile")
        .update({ logo_path: path, updated_by: user.id, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
    : await supabase.from("org_profile").insert({ logo_path: path, updated_by: user.id, updated_at: new Date().toISOString() });
  if (writeError) {
    // The row was never updated to point at the new file -- remove the
    // upload so it doesn't linger as an orphan nothing references.
    await supabase.storage.from("org-logos").remove([path]);
    return { error: writeError.message };
  }

  // Old logo replaced: remove it now that the row points at the new one.
  // Best-effort -- an old-logo removal failure doesn't undo the (already
  // successful) new upload.
  if (existing?.logo_path && existing.logo_path !== path) {
    await supabase.storage.from("org-logos").remove([existing.logo_path]);
  }

  revalidatePath("/organization");
  return { ok: true };
}

export async function removeOrgLogo(storagePath: string): Promise<{ ok: true } | { error: string }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error: removeError } = await supabase.storage.from("org-logos").remove([storagePath]);
  if (removeError) return { error: removeError.message };

  // Predicated on logo_path still matching the path being removed, so a
  // logo replaced in between (a new upload) is never clobbered back to
  // null by a stale remove request.
  const { error } = await supabase
    .from("org_profile")
    .update({ logo_path: null, updated_by: user.id, updated_at: new Date().toISOString() })
    .eq("logo_path", storagePath);
  if (error) return { error: error.message };

  revalidatePath("/organization");
  return { ok: true };
}
