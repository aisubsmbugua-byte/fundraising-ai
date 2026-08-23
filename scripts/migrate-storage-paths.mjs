// One-time script: relocates existing org-documents storage objects
// (uploaded before multi-tenancy) under the bootstrap organization's
// id prefix, so they match the new path-prefix-checking RLS policy in
// 0034_storage_multi_tenant.sql. Run this AFTER 0032/0033 have been
// applied (organizations/profiles must exist) and BEFORE 0034 goes
// live -- the new storage policies expect every object to already be
// prefixed, or the existing user's uploads go briefly unreadable.
//
// Usage: node --env-file=.env.local scripts/migrate-storage-paths.mjs
//
// Safe to re-run: skips any storage_path that already contains a "/".

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: org, error: orgError } = await admin
  .from("organizations")
  .select("id")
  .eq("name", "Village Worship Initiative")
  .single();
if (orgError || !org) {
  console.error("Could not find the bootstrap organization -- has 0032_multi_tenant_foundation.sql run yet?", orgError?.message);
  process.exit(1);
}

const { data: docs, error: docsError } = await admin.from("org_documents").select("id, storage_path");
if (docsError) {
  console.error("Failed to list org_documents:", docsError.message);
  process.exit(1);
}

let moved = 0;
let skipped = 0;
for (const doc of docs ?? []) {
  if (doc.storage_path.includes("/")) {
    skipped++;
    continue;
  }
  const newPath = `${org.id}/${doc.storage_path}`;
  const { error: moveError } = await admin.storage.from("org-documents").move(doc.storage_path, newPath);
  if (moveError) {
    console.error(`Failed to move ${doc.id} (${doc.storage_path}):`, moveError.message);
    continue;
  }
  const { error: updateError } = await admin.from("org_documents").update({ storage_path: newPath }).eq("id", doc.id);
  if (updateError) {
    console.error(`Moved storage object for ${doc.id} but failed to update its row:`, updateError.message);
    continue;
  }
  moved++;
}

console.log(`Done. Moved ${moved}, already prefixed (skipped) ${skipped}, total ${docs?.length ?? 0}.`);
