"use client";

import { useState } from "react";
import { uploadOrgDocument } from "./documents/actions";
import DeleteDocumentButton from "./documents/delete-document-button";
import SubmitButton from "@/components/SubmitButton";
import { spacing, colors, fieldStyle, buttonSecondary, cardStyle } from "@/lib/ui";

type OrgDocumentWithUrl = {
  id: string;
  file_name: string;
  storage_path: string;
  file_size: number | null;
  uploaded_at: string;
  url: string | null;
};

function formatFileSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsModal({ documents }: { documents: OrgDocumentWithUrl[] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} style={buttonSecondary}>
        Upload Documents
      </button>
      {open && (
        <div
          role="presentation"
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: 24,
              maxWidth: 560,
              width: "90%",
              maxHeight: "80vh",
              overflowY: "auto",
              boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ fontSize: 18 }}>Upload Documents</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{ border: "none", background: "none", cursor: "pointer", fontSize: 20, color: colors.textMuted }}
              >
                ×
              </button>
            </div>
            <p style={{ color: colors.textMuted, fontSize: 14 }}>
              Upload supporting documents (990s, strategic plans, annual reports) for your team&apos;s
              reference. These are stored for humans to read — they aren&apos;t yet parsed for AI to use
              directly.
            </p>

            <form
              action={uploadOrgDocument}
              style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md, alignItems: "center" }}
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

            <div style={{ display: "grid", gap: spacing.sm, marginTop: spacing.lg }}>
              {documents.map((doc) => (
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
              {documents.length === 0 && <p style={{ color: colors.textFaint }}>No documents uploaded yet.</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
