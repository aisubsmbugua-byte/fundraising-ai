import Link from "next/link";
import { getAutoSearchSettings } from "./auto-search-actions";
import AutoSearchForm from "./auto-search-form";
import { spacing } from "@/lib/ui";

export default async function SettingsPage() {
  const settings = await getAutoSearchSettings();

  return (
    <div>
      <h1>Settings</h1>
      <ul style={{ marginTop: 16 }}>
        <li>
          <Link href="/settings/screening">Screening Rules</Link>
        </li>
      </ul>

      <div style={{ marginTop: spacing.xxl }}>
        <AutoSearchForm settings={settings} />
      </div>
    </div>
  );
}
