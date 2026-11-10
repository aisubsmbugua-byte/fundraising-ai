import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canOpenFunderDatabase } from "@/lib/funder-reference/access";

// STATE item 113, ruling 0048 clause 1: an internal screen. The door is
// canOpenFunderDatabase -- the one place that says who may open it. Anyone else
// who types the address is sent to the pipeline, as /admin does.
export default async function FundersLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await canOpenFunderDatabase(supabase, user.id))) redirect("/pipeline");
  return <>{children}</>;
}
