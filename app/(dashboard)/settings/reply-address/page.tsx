import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveReplyTo, REPLY_TO_METADATA_KEY } from "@/lib/draft-send";
import { spacing, colors, sectionStyle, chipStyle, type as typeScale } from "@/lib/ui";
import ReplyAddressForm from "./reply-address-form";

export const dynamic = "force-dynamic";

// STATE item 106, rulings 0042/0043. Where a funder's reply to YOUR email goes. The
// address shown is computed by resolveReplyTo -- the same function the
// confirmation before every send and the send itself use -- on the freshly
// fetched user (getUser, a server round trip, never the cookie's cached
// claims), so this page cannot show an address the send would not use. It
// reads no environment variable: a reply address equal to the sending address
// is valid (ruling 0043).
export default async function ReplyAddressPage() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const resolved = resolveReplyTo({
    accountEmail: user.email,
    metadata: user.user_metadata,
  });

  const rawStored = (user.user_metadata as Record<string, unknown> | null | undefined)?.[REPLY_TO_METADATA_KEY];
  const stored = typeof rawStored === "string" ? rawStored.trim() : "";
  // A value is saved but is not what replies use (it is not a usable single
  // address): say so instead of leaving a quiet gap between what the person
  // typed and what happens.
  const unusableStored = stored !== "" && resolved.source === "account";

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: typeScale.pageTitle }}>Reply address</h1>
      <p style={{ color: colors.textMuted, fontSize: 14, marginTop: spacing.xs }}>
        When a funder replies to an email you send from this platform, the reply goes to the address below.
      </p>

      <div style={{ ...sectionStyle, marginTop: spacing.xl }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Replies currently go to</h2>
        <p style={{ margin: 0, fontSize: 16, fontWeight: 600, wordBreak: "break-all" }}>
          {resolved.address ?? "No address — your account has no email"}
        </p>
        <div>
          <span style={chipStyle(resolved.source === "chosen" ? "teal" : "neutral")}>
            {resolved.source === "chosen" ? "The address you chose" : "Your sign-in address"}
          </span>
        </div>
        {unusableStored && (
          <p style={{ margin: 0, fontSize: 13, color: colors.amber700 }}>
            You have a saved reply address ({stored}), but it cannot be used, so replies go to your sign-in address.
            Save a different address below, or clear it.
          </p>
        )}
      </div>

      <div style={{ ...sectionStyle, marginTop: spacing.xl }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Choose another address</h2>
        <ReplyAddressForm initial={resolved.source === "chosen" ? (resolved.address ?? "") : ""} hasStored={stored !== ""} />
      </div>

      <div style={{ ...sectionStyle, marginTop: spacing.xl }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>What to know</h2>
        <p style={{ margin: 0, fontSize: 14 }}>
          The platform cannot check that you control the address you enter. Use one you read, such as your organization&apos;s.
        </p>
        <p style={{ margin: 0, fontSize: 14 }}>
          This applies only to replies to emails <strong>you</strong> send to funders. It is your own choice: it is stored with your account, and no teammate&apos;s choice changes yours or you theirs.
        </p>
        <p style={{ margin: 0, fontSize: 14 }}>
          The confirmation you see before every send shows exactly the address that will be used. Changing it here never changes an email already sent. The address emails are sent <em>from</em> is the platform&apos;s and is not changed here.
        </p>
      </div>
    </div>
  );
}
