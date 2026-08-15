import { createRule } from "../actions";
import RuleForm from "../rule-form";

export default function NewRulePage() {
  return (
    <div style={{ maxWidth: 480 }}>
      <h1>New Screening Rule</h1>
      <RuleForm action={createRule} />
    </div>
  );
}
