import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { uploadOrgDocument } from "./actions";
import DeleteDocumentButton from "./delete-document-button";
import SubmitButton from "@/components/SubmitButton";
import { spacing, colors, fieldStyle, cardStyle } from "@/lib/ui";

type OrgDocument = {
  id: string;
  file_name: string;
  storage_path: string;
  file_size: number | null;
  content_type: string | null;
  uploaded_by: string;
  uploaded_at: string;
};

function formatFileSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function OrgDocumentsPage() {
  const supabase = createClient();
  const { data: documents, error } = await supabase
    .from("org_documents")
    .select("*")
    .order("uploaded_at", { ascending: false })
    .returns<OrgDocument[]>();

  // Fresh signed URL per document (1 hour expiry) -- the bucket is
  // private, so files are only reachable this way, never by a public URL.
  const withUrls = await Promise.all(
    (documents ?? []).map(async (doc) => {
      const { data } = await supabase.storage.from("org-documents").createSignedUrl(doc.storage_path, 3600);
      return { ...doc, url: data?.signedUrl ?? null };
    })
  );

  return (
    <div style={{ maxWidth: 640 }}>
      <Link href="/organization" style={{ fontSize: 14, color: colors.textMuted, textDecoration: "none" }}>
        ← Back to Organization Profile
      </Link>
      <h1>Upload Documents</h1>
      <p style={{ color: colors.textMuted, fontSize: 14 }}>
        Upload supporting documents (990s, strategic plans, annual reports) for your team&apos;s
        reference. These are stored for humans to read — they aren&apos;t yet parsed for AI to use
        directly.
      </p>

      <form
        action={uploadOrgDocument}
        style={{ display: "flex", gap: spacing.sm, marginTop: spacing.lg, alignItems: "center" }}
      >
        <input
          type="file"
          name="file"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
          required
          style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
        />
        <SubmitButton>Upload</SubmitButton>
      </form>

      {error && <p style={{ color: "crimson", marginTop: spacing.md }}>Error loading documents: {error.message}</p>}

      <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.xl }}>
        {withUrls.map((doc) => (
          <div
            key={doc.id}
            style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <div>
              {doc.url ? (
                <a href={doc.url} target="_blank" rel="noopener noreferrer">
                  {doc.file_name}
                </a>
              ) : (
                <span>{doc.file_name}</span>
              )}
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                {formatFileSize(doc.file_size)} · {new Date(doc.uploaded_at).toLocaleDateString()}
              </div>
            </div>
            <DeleteDocumentButton id={doc.id} storagePath={doc.storage_path} fileName={doc.file_name} />
          </div>
        ))}
        {withUrls.length === 0 && <p style={{ color: colors.textFaint }}>No documents uploaded yet.</p>}
      </div>
    </div>
  );
}
