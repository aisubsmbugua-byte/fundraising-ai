import { redirect } from "next/navigation";

// Folded into Pipeline as its List view -- this route stays so old
// links/bookmarks still land somewhere real.
export default function ProspectsPage() {
  redirect("/pipeline?view=list");
}
