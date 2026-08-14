export const CHANNELS = [
  { value: "foundation", label: "Foundation & Family Trust" },
  { value: "regranting", label: "Regranting Ministry" },
  { value: "christian_business", label: "Christian Business" },
  { value: "denomination", label: "Denomination & Network Fund" },
  { value: "daf", label: "Donor-Advised Fund (DAF)" },
  { value: "major_donor", label: "Major Donor" },
] as const;

export type Channel = (typeof CHANNELS)[number]["value"];

export function channelLabel(channel: string) {
  return CHANNELS.find((c) => c.value === channel)?.label ?? channel;
}

export type Prospect = {
  id: string;
  name: string;
  channel: Channel;
  organization: string | null;
  contact_name: string | null;
  contact_email: string | null;
  website: string | null;
  notes: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
};
