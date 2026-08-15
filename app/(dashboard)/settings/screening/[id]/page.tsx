import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateRule } from "../actions";
import RuleForm from "../rule-form";
import type { ScreeningRule } from "@/lib/screening";

export default async function EditRulePage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: rule } = await supabase
    .from("screening_rules")
    .select("*")
    .eq("id", params.id)
    .single<ScreeningRule>();

  if (!rule) notFound();

  const boundUpdate = updateRule.bind(null, rule.id);

  return (
    <div style={{ maxWidth: 480 }}>
      <h1>Edit Rule</h1>
      <RuleForm action={boundUpdate} rule={rule} />
    </div>
  );
}
