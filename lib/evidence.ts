export const EVIDENCE_TYPES = [
  { value: "outcome", label: "Outcome" },
  { value: "story", label: "Story" },
  { value: "testimonial", label: "Testimonial" },
  { value: "document", label: "Document" },
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number]["value"];

export function evidenceTypeLabel(type: string) {
  return EVIDENCE_TYPES.find((t) => t.value === type)?.label ?? type;
}

export const EVIDENCE_PERMISSIONS = [
  { value: "approved", label: "Approved for AI use" },
  { value: "restricted", label: "Restricted" },
] as const;

export type EvidencePermission = (typeof EVIDENCE_PERMISSIONS)[number]["value"];

export type EvidenceItem = {
  id: string;
  title: string;
  description: string;
  type: EvidenceType;
  program: string | null;
  geography: string | null;
  permission: EvidencePermission;
  verified_at: string | null;
  verified_by: string | null;
  source_document_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
