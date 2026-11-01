import Link from "next/link";
import { spacing, colors, type as typeScale } from "@/lib/ui";
import ImportWorkspace from "./import-workspace";

// Import people from any list the organization already holds (STATE item 103,
// ruling 0040). The file is read in the browser; nothing leaves it until the
// person has mapped the columns, chosen a strength and seen what will happen.
export default function ImportNetworkPage() {
  return (
    <div>
      <p style={{ margin: 0, fontSize: 13 }}>
        <Link href="/network" style={{ color: colors.textMuted }}>
          ← Back to Network
        </Link>
      </p>
      <h1 style={{ fontSize: typeScale.pageTitle, marginTop: spacing.xs }}>Import people from a file</h1>
      <p style={{ color: colors.textMuted, marginTop: spacing.xs, maxWidth: 680, fontSize: 14 }}>
        Add people from any list you hold — a donor list, a board list, an export from any service — as a CSV file. You tell
        this page which column is which; it never guesses. Only a name, where they work or serve, how you know them, your notes
        and how close you are are kept. Nothing else in the file is stored.
      </p>
      <ImportWorkspace />
    </div>
  );
}
