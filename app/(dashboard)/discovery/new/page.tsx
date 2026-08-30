"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createCandidate } from "../actions";
import type { ExistingFunder } from "@/lib/candidate-intake";
import { CHANNELS } from "@/lib/prospects";
import { spacing, colors, radiusSm, fieldStyle, labelStyle, buttonPrimary, buttonSecondary } from "@/lib/ui";

export default function NewCandidatePage() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [duplicate, setDuplicate] = useState<ExistingFunder | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Submits through a handler rather than binding the action directly, because
  // a duplicate is an answer this page has to RENDER -- with every field still
  // filled in -- not a redirect and not a thrown error. Retyping the form to
  // find out something already exists is how repeat entries get made.
  async function submit(form: HTMLFormElement, confirmDuplicate: boolean) {
    setPending(true);
    setError(null);
    const formData = new FormData(form);
    if (confirmDuplicate) formData.set("confirm_duplicate", "1");
    try {
      const result = await createCandidate(formData);
      if ("duplicate" in result) {
        setDuplicate(result.duplicate);
        setPending(false);
        return;
      }
      if ("error" in result) {
        setError(result.error);
        setPending(false);
        return;
      }
      router.push("/discovery");
      router.refresh();
    } catch {
      setError("Something went wrong saving this candidate. Try again.");
      setPending(false);
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h1>Add Candidate</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(e.currentTarget, false);
        }}
        style={{ display: "grid", gap: spacing.md, marginTop: spacing.lg }}
      >
        <label style={labelStyle}>
          Name *
          <input name="name" required style={fieldStyle} onChange={() => setDuplicate(null)} />
        </label>
        <label style={labelStyle}>
          Channel *
          <select name="channel" required defaultValue="" style={fieldStyle}>
            <option value="" disabled>
              Select a channel
            </option>
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Organization
          <input name="organization" style={fieldStyle} onChange={() => setDuplicate(null)} />
        </label>
        <label style={labelStyle}>
          Website
          <input name="website" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Contact name
          <input name="contact_name" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Contact email
          <input name="contact_email" type="email" style={fieldStyle} />
        </label>

        <div style={{ fontSize: 13, fontWeight: 600, marginTop: spacing.sm }}>
          Funder intelligence (optional — fill in what you already know; research fills gaps
          later, never overwrites what you enter here)
        </div>
        <label style={labelStyle}>
          Location
          <input name="location" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Funder type
          <input name="funder_type" placeholder="e.g. private foundation, corporate giving" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Geographic focus
          <input name="geographic_focus" placeholder="e.g. nationwide, California only" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Typical grant size
          <input name="typical_grant_size" placeholder="e.g. $5,000-$25,000" style={fieldStyle} />
        </label>
        <label style={labelStyle}>
          Focus areas (comma-separated)
          <input name="focus_areas" style={fieldStyle} />
        </label>

        {duplicate && (
          <div style={{ padding: spacing.md, borderRadius: radiusSm, border: `1px solid ${colors.border}`, display: "grid", gap: spacing.sm }}>
            <div style={{ fontSize: 13, color: colors.text }}>
              <strong>{duplicate.name}</strong>{" "}
              {duplicate.kind === "prospect"
                ? `is already in your pipeline at the ${duplicate.status ?? "discovery"} stage.`
                : `is already in your discovery queue${duplicate.status ? ` (${duplicate.status})` : ""}.`}
            </div>
            <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
              <Link
                href={duplicate.kind === "prospect" ? `/prospects/${duplicate.id}` : "/discovery"}
                style={{ ...buttonSecondary, textDecoration: "none", display: "inline-block" }}
              >
                Open the existing record
              </Link>
              {/* Overrulable on purpose: two genuinely different churches can
                  share a name, and the person entering it would know that. */}
              <button
                type="button"
                disabled={pending}
                style={buttonSecondary}
                onClick={(e) => {
                  const form = e.currentTarget.closest("form");
                  if (form) submit(form, true);
                }}
              >
                Add anyway
              </button>
            </div>
          </div>
        )}

        {error && <div style={{ fontSize: 13, color: colors.text }}>{error}</div>}

        {/* Disabled while in flight. The five Graceway rows included a pair
            1.4 seconds apart -- one click landing twice. */}
        <button type="submit" disabled={pending} style={{ ...buttonPrimary, opacity: pending ? 0.6 : 1 }}>
          {pending ? "Adding..." : "Add Candidate"}
        </button>
      </form>
    </div>
  );
}
