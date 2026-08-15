import Link from "next/link";

export default function SettingsPage() {
  return (
    <div>
      <h1>Settings</h1>
      <ul style={{ marginTop: 16 }}>
        <li>
          <Link href="/settings/organization">Organization Profile</Link>
        </li>
        <li>
          <Link href="/settings/screening">Screening Rules</Link>
        </li>
      </ul>
    </div>
  );
}
