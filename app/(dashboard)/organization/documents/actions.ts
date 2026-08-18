"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export async function uploadOrgDocument(formData: FormData) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    throw new Error("Choose a file to upload");
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("File is too large (25MB max)");
  }

  const path = `${crypto.randomUUID()}-${file.name}`;

  const { error: uploadError } = await supabase.storage.from("org-documents").upload(path, file);
  if (uploadError) throw new Error(uploadError.message);

  const { error: insertError } = await supabase.from("org_documents").insert({
    file_name: file.name,
    storage_path: path,
    file_size: file.size,
    content_type: file.type || null,
    uploaded_by: user.id,
  });
  if (insertError) throw new Error(insertError.message);

  revalidatePath("/organization");
}

export async function deleteOrgDocument(id: string, storagePath: string) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  await supabase.storage.from("org-documents").remove([storagePath]);

  const { error } = await supabase.from("org_documents").delete().eq("id", id);
  if (error) throw new Error(error.message);

  revalidatePath("/organization");
}
