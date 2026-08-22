"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X, type LucideIcon } from "lucide-react";
import { colors, radiusSm, radiusPill } from "@/lib/ui";
import PipelineNavItem from "@/components/PipelineNavItem";
import InitialsAvatar from "@/components/InitialsAvatar";

type NavItem = { href: string; label: string; badge: number; icon: LucideIcon };
type StageCount = { value: string; label: string; count: number };

export default function Sidebar({
  beforePipeline,
  afterPipeline,
  stageCounts,
  userEmail,
}: {
  beforePipeline: NavItem[];
  afterPipeline: NavItem[];
  stageCounts: StageCount[];
  userEmail: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // A nav click should close the drawer on mobile -- otherwise the
  // new page renders underneath a still-open overlay.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      <div className="mobile-topbar">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", display: "flex", padding: 4 }}
        >
          <Menu size={22} />
        </button>
        <span style={{ fontWeight: 700, fontSize: 15 }}>Fundraising AI</span>
      </div>

      <div className={`sidebar-backdrop${open ? " is-open" : ""}`} onClick={() => setOpen(false)} role="presentation" />

      <nav
        className={`sidebar${open ? " is-open" : ""}`}
        style={{
          width: 232,
          flexShrink: 0,
          background: colors.navy950,
          color: "#fff",
          padding: 20,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>Fundraising AI</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="sidebar-close-button"
            style={{ background: "none", border: "none", color: "#cbd5e1", cursor: "pointer", display: "none", padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>
        <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 4, flex: 1, alignContent: "start" }}>
          {beforePipeline.map((n) => (
            <NavLink key={n.href} {...n} />
          ))}
          <PipelineNavItem stageCounts={stageCounts} />
          {afterPipeline.map((n) => (
            <NavLink key={n.href} {...n} />
          ))}
        </ul>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 16,
            paddingTop: 16,
            borderTop: "1px solid rgba(255,255,255,0.1)",
          }}
        >
          <InitialsAvatar name={userEmail} size={32} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {userEmail}
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}

function NavLink({ href, label, badge, icon: Icon }: NavItem) {
  return (
    <li>
      <Link
        href={href}
        prefetch={false}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 10px",
          borderRadius: radiusSm,
          color: "#cbd5e1",
          textDecoration: "none",
          fontSize: 14,
        }}
      >
        <Icon size={16} strokeWidth={2} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{label}</span>
        {badge > 0 && (
          <span
            style={{
              background: colors.amber700,
              color: "#fff",
              borderRadius: radiusPill,
              padding: "1px 8px",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {badge}
          </span>
        )}
      </Link>
    </li>
  );
}
