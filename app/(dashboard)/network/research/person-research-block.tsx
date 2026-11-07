"use client";

// A confirmed person's research, in the people list on the Network page (STATE item
// 112, ruling 0044): what was found, with its sources, labelled "not yet reviewed by
// a person", with Strike on each; or, for a person not yet researched, one button,
// "Research this person", whose click is the consent to spend an AI run. Nothing here
// starts on load.

import { FindingsSection } from "./findings-view";
import { usePersonResearch, type InitialResearch } from "./use-person-research";
import { spacing, colors } from "@/lib/ui";

export default function PersonResearchBlock({ personId, name, initial }: { personId: string; name: string; initial: InitialResearch }) {
  const research = usePersonResearch(personId, initial);
  return (
    <div style={{ marginTop: spacing.md, borderTop: `1px solid ${colors.border}`, paddingTop: spacing.md }}>
      <FindingsSection name={name} research={research} showStart />
    </div>
  );
}
