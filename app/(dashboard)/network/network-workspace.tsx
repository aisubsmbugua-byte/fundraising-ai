"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  addConnection,
  updateConnection,
  deleteConnection,
  deleteConnections,
  getMatchingConnectionIds,
  type ConnectionInput,
} from "./actions";
import { findIdentityCandidates, loadPersonCandidates, resetIdentity, setDoNotResearch } from "./identity-actions";
import { AddPersonResultView, type AddPhase } from "./add-person-result";
import LookupRunner from "./identity/lookup-runner";
import ConfirmDialog from "@/components/ConfirmDialog";
import { CONNECTION_STRENGTHS, NETWORK_DISCLOSURE, type NetworkConnection } from "@/lib/network";
import { IDENTITY_STATE_LABEL, identityState, type IdentityState } from "@/lib/network-identity";
import { planAutoLook } from "@/lib/network-identity-flow";
import type { IdentityCounts } from "@/lib/network-identity-store";
import { networkHref, type PageWindow } from "@/lib/network-list";
import { spacing, colors, fieldStyle, labelStyle, buttonPrimary, buttonSecondary, buttonDanger, sectionStyle, cardStyle, chipStyle } from "@/lib/ui";

const STRENGTH_LABEL: Record<string, string> = { close: "Close", warm: "Warm", acquaintance: "Acquaintance" };

const EMPTY: ConnectionInput = { person_name: "", affiliation: "", title: "", city: "", state: "", do_not_research: false, how_known: "", strength: "", notes: "" };

function toInput(c: NetworkConnection): ConnectionInput {
  return {
    person_name: c.person_name,
    affiliation: c.affiliation ?? "",
    title: c.title ?? "",
    city: c.city ?? "",
    state: c.state ?? "",
    do_not_research: c.do_not_research === true,
    how_known: c.how_known ?? "",
    strength: c.strength,
    notes: c.notes ?? "",
  };
}

// What the page knows about each person's identity, passed down as plain data.
export type IdentityPageData = {
  // False when the identity columns or tables are not there yet (migration
  // 0083 not applied): the identity controls are hidden and the page says why.
  available: boolean;
  counts: IdentityCounts | null;
  // How many recorded people are waiting to be looked up (null when it could
  // not be worked out). The count on the "Confirm your network" button.
  eligible?: number | null;
  byId: Record<string, { candidateCount: number; lookedEmpty: boolean }>;
};

const STATE_TONE: Record<IdentityState, "teal" | "amber" | "red" | "neutral"> = {
  not_looked_at: "neutral",
  no_candidates_found: "neutral",
  candidates: "amber",
  confirmed: "teal",
  none_of_these: "neutral",
  do_not_research: "red",
};

function stateOf(c: NetworkConnection, identity: IdentityPageData): IdentityState {
  const ctx = identity.byId[c.id];
  return identityState(c, ctx?.candidateCount ?? 0, ctx?.lookedEmpty ?? false);
}

// One form for add and edit. The disclosure sentence (ruling 0033 clause 3)
// sits on the form itself, where the data is entered. Strength has no default:
// the select starts on an empty choice and the action refuses an omitted value.
function ConnectionForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: ConnectionInput;
  submitLabel: string;
  onSubmit: (input: ConnectionInput) => Promise<{ error: string } | { success: true }>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<ConnectionInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const set = (key: keyof ConnectionInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await onSubmit(values);
          if ("error" in result) setError(result.error);
          else if (!onCancel) setValues(EMPTY);
        });
      }}
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.md }}
    >
      <p
        style={{
          margin: 0,
          fontSize: 13,
          color: colors.text,
          background: colors.amber100,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          padding: spacing.md,
        }}
      >
        {NETWORK_DISCLOSURE}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: spacing.md }}>
        <label style={labelStyle}>
          Name
          <input style={fieldStyle} value={values.person_name} onChange={set("person_name")} required />
        </label>
        <label style={labelStyle}>
          Where they work or serve
          <input style={fieldStyle} value={values.affiliation} onChange={set("affiliation")} />
        </label>
        <label style={labelStyle}>
          How close are you
          <select style={fieldStyle} value={values.strength} onChange={set("strength")} required>
            <option value="" disabled>
              Choose one
            </option>
            {CONNECTION_STRENGTHS.map((s) => (
              <option key={s} value={s}>
                {STRENGTH_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: spacing.md }}>
        <label style={labelStyle}>
          Title or role
          <input style={fieldStyle} value={values.title ?? ""} onChange={set("title")} />
        </label>
        <label style={labelStyle}>
          City
          <input style={fieldStyle} value={values.city ?? ""} onChange={set("city")} />
        </label>
        <label style={labelStyle}>
          State or region
          <input style={fieldStyle} value={values.state ?? ""} onChange={set("state")} />
        </label>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: colors.textMuted }}>
        Where they work, their title, their city and their state are what the platform uses to tell this person from others with the same name. They are
        optional, but a name alone cannot be matched to the right person.{onCancel ? " Changing the name or any of these four clears a confirmed identity, because it was confirmed for the details as recorded." : ""}
      </p>
      <label style={labelStyle}>
        How you know them
        <input style={fieldStyle} value={values.how_known} onChange={set("how_known")} />
      </label>
      <label style={labelStyle}>
        Notes
        <textarea style={{ ...fieldStyle, minHeight: 72 }} value={values.notes} onChange={set("notes")} />
      </label>
      <label style={{ display: "flex", gap: spacing.sm, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={values.do_not_research === true}
          onChange={(e) => setValues((v) => ({ ...v, do_not_research: e.target.checked }))}
          style={{ marginTop: 3 }}
        />
        <span>
          Do not research this person. Nothing will be looked up about them, and anything already found is removed.
        </span>
      </label>
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button type="submit" disabled={isPending} style={buttonPrimary}>
          {isPending ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={isPending} style={buttonSecondary}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// Adding ONE person by hand (STATE item 109). Once they are saved, the platform
// looks for their matches by itself and shows them here, in place. That look is
// the only thing that happens automatically: confirming is a click on a button in
// the panel (PersonCard), never anything this component does. The person is saved
// before any of this starts, and nothing here can undo or block the save.
function AddPersonSection({ identityAvailable }: { identityAvailable: boolean }) {
  const [phase, setPhase] = useState<AddPhase>({ kind: "idle" });
  // The person just saved, for "Try again" and for "Add details".
  const [saved, setSaved] = useState<{ id: string; input: ConnectionInput } | null>(null);
  const [editing, setEditing] = useState(false);

  const readMatches = async (id: string, name: string) => {
    const loaded = await loadPersonCandidates(id);
    if ("error" in loaded) {
      setPhase({ kind: "failed", name, message: loaded.error, step: "read" });
      return;
    }
    if (!loaded.person) {
      setPhase({ kind: "no_matches", name, message: "Saved. There is nothing to confirm for this person." });
      return;
    }
    setPhase({ kind: "matches", name, person: loaded.person });
  };

  const lookFor = async (id: string, name: string) => {
    setPhase({ kind: "looking", name });
    const found = await findIdentityCandidates(id);
    if ("error" in found) {
      setPhase({ kind: "failed", name, message: found.error, step: "look" });
      return;
    }
    if (found.stored === 0) {
      setPhase({ kind: "no_matches", name, message: `Saved. ${found.message}` });
      return;
    }
    await readMatches(id, name);
  };

  const afterSave = (id: string | null, input: ConnectionInput) => {
    setEditing(false);
    if (!identityAvailable || !id) {
      setSaved(null);
      setPhase({ kind: "idle" });
      return;
    }
    setSaved({ id, input });
    const name = input.person_name.trim();
    const plan = planAutoLook(input);
    if (!plan.look) {
      setPhase({ kind: "not_looked", name, message: plan.message, canAddDetails: plan.reason === "too_few_facts" });
      return;
    }
    void lookFor(id, name);
  };

  return (
    <>
      <ConnectionForm
        initial={EMPTY}
        submitLabel="Add to network"
        onSubmit={async (input) => {
          const result = await addConnection(input);
          // Saved. The look starts here and is NOT awaited, so the form is free again at once.
          if ("success" in result) afterSave(result.id, input);
          return result;
        }}
      />
      {editing && saved ? (
        <div style={cardStyle}>
          <ConnectionForm
            initial={saved.input}
            submitLabel="Save and look for matches"
            onCancel={() => setEditing(false)}
            onSubmit={async (input) => {
              const result = await updateConnection(saved.id, input);
              if ("success" in result) afterSave(saved.id, input);
              return result;
            }}
          />
        </div>
      ) : (
        <AddPersonResultView
          phase={phase}
          onTryAgain={() => {
            if (!saved) return;
            const name = saved.input.person_name.trim();
            if (phase.kind === "failed" && phase.step === "read") void readMatches(saved.id, name);
            else void lookFor(saved.id, name);
          }}
          onAddDetails={() => setEditing(true)}
        />
      )}
    </>
  );
}

function ConnectionCard({
  connection,
  checked,
  onToggle,
  identity,
}: {
  connection: NetworkConnection;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  identity: IdentityPageData;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const state = stateOf(connection, identity);
  const where = [connection.city, connection.state].filter(Boolean).join(", ");

  if (editing) {
    return (
      <div style={cardStyle}>
        <ConnectionForm
          initial={toInput(connection)}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            const result = await updateConnection(connection.id, input);
            if ("success" in result) setEditing(false);
            return result;
          }}
        />
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: spacing.md, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, display: "flex", gap: spacing.sm, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Select ${connection.person_name} for removal`}
            style={{ flexShrink: 0, cursor: "pointer", marginTop: 4 }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>{connection.person_name}</div>
            {connection.affiliation && <div style={{ fontSize: 13, color: colors.textMuted }}>{connection.affiliation}</div>}
            {(connection.title || where) && <div style={{ fontSize: 13, color: colors.textMuted }}>{[connection.title, where].filter(Boolean).join(" · ")}</div>}
          </div>
        </div>
        <div style={{ display: "flex", gap: spacing.xs, alignItems: "flex-start", flexWrap: "wrap" }}>
          {identity.available && <span style={chipStyle(STATE_TONE[state])}>{IDENTITY_STATE_LABEL[state]}</span>}
          <span style={chipStyle(connection.strength === "close" ? "teal" : connection.strength === "warm" ? "amber" : "neutral")}>
            {STRENGTH_LABEL[connection.strength] ?? connection.strength}
          </span>
        </div>
      </div>
      {connection.how_known && (
        <p style={{ fontSize: 13, margin: `${spacing.sm}px 0 0` }}>
          <span style={{ color: colors.textMuted }}>How you know them: </span>
          {connection.how_known}
        </p>
      )}
      {connection.notes && <p style={{ fontSize: 13, color: colors.textMuted, margin: `${spacing.xs}px 0 0` }}>{connection.notes}</p>}
      {notice && <p style={{ fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{notice}</p>}
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: `${spacing.sm}px 0 0` }}>{error}</p>}
      <div style={{ display: "flex", gap: spacing.sm, marginTop: spacing.md, flexWrap: "wrap" }}>
        <button type="button" style={buttonSecondary} onClick={() => setEditing(true)} disabled={isPending}>
          Edit
        </button>
        {identity.available && (state === "not_looked_at" || state === "no_candidates_found" || state === "candidates") && (
          <button
            type="button"
            style={buttonSecondary}
            disabled={isPending}
            onClick={() => {
              setError(null);
              setNotice(null);
              startTransition(async () => {
                const result = await findIdentityCandidates(connection.id);
                if ("error" in result) setError(result.error);
                else setNotice(result.message);
              });
            }}
          >
            {isPending ? "Looking…" : state === "not_looked_at" ? "Find matches" : "Look again"}
          </button>
        )}
        {identity.available && state === "candidates" && (
          <Link href="/network/identity" style={{ ...buttonSecondary, textDecoration: "none" }}>
            Review matches
          </Link>
        )}
        {identity.available && (state === "confirmed" || state === "none_of_these") && (
          <button type="button" style={buttonSecondary} onClick={() => setResetting(true)} disabled={isPending}>
            Reset identity
          </button>
        )}
        <button type="button" style={buttonDanger} onClick={() => setConfirming(true)} disabled={isPending}>
          {isPending ? "Deleting…" : "Delete"}
        </button>
      </div>
      <ConfirmDialog
        open={resetting}
        title="Reset this person's identity"
        message={`Clear the ${state === "confirmed" ? "confirmed identity" : "\"none of these\" decision"} for "${connection.person_name}" and the candidates found for them? They can then be looked up again.`}
        confirmLabel="Reset"
        onCancel={() => setResetting(false)}
        onConfirm={() => {
          setResetting(false);
          setError(null);
          setNotice(null);
          startTransition(async () => {
            const result = await resetIdentity(connection.id);
            if ("error" in result) setError(result.error);
          });
        }}
      />
      <ConfirmDialog
        open={confirming}
        title="Delete this person"
        message={`Delete "${connection.person_name}" from your network? Any introduction paths suggested through them will be deleted too, and so will any candidates found for them. This can't be undone.`}
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          setError(null);
          startTransition(async () => {
            const result = await deleteConnection(connection.id);
            if ("error" in result) setError(result.error);
          });
        }}
      />
    </div>
  );
}

// The people list: one page of cards, with search, paging and multi-select. It
// is keyed by the page and search in the parent, so the selection starts clean
// whenever either changes -- "Select all N matching" is how a selection spans
// pages. Removal is never instant: it expands a confirm step naming how many.
function PeopleList({
  connections,
  totalRecorded,
  matching,
  q,
  window: win,
  identity,
}: {
  connections: NetworkConnection[];
  totalRecorded: number;
  matching: number;
  q: string;
  window: PageWindow;
  identity: IdentityPageData;
}) {
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const pageIds = connections.map((c) => c.id);
  const allOnPageChecked = pageIds.length > 0 && pageIds.every((id) => checkedIds.has(id));
  const toggle = (id: string, checked: boolean) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const togglePage = (checked: boolean) =>
    setCheckedIds((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) (checked ? next.add(id) : next.delete(id));
      return next;
    });

  const selectAllMatching = () => {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await getMatchingConnectionIds(q);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setCheckedIds(new Set(result.ids));
    });
  };

  const markSelected = (value: boolean) => {
    setError(null);
    setNotice(null);
    const ids = Array.from(checkedIds);
    startTransition(async () => {
      const result = await setDoNotResearch(ids, value);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setCheckedIds(new Set());
      setNotice(
        value
          ? `Marked ${result.changed} ${result.changed === 1 ? "person" : "people"} do not research. Anything found about ${result.changed === 1 ? "them" : "them"} was removed and nothing will be looked up.`
          : `Research is allowed again for ${result.changed} ${result.changed === 1 ? "person" : "people"}.`
      );
    });
  };

  const removeSelected = () => {
    setError(null);
    setNotice(null);
    const ids = Array.from(checkedIds);
    startTransition(async () => {
      const result = await deleteConnections(ids);
      if ("error" in result) {
        setError(result.error);
        setConfirmOpen(false);
        return;
      }
      setConfirmOpen(false);
      setCheckedIds(new Set());
      setNotice(`Removed ${result.deleted} ${result.deleted === 1 ? "person" : "people"}${result.deleted < ids.length ? ` (of ${ids.length} selected; the rest were not found)` : ""}.`);
    });
  };

  return (
    <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.md }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 17, margin: 0 }}>
          People you have recorded ({totalRecorded})
          {q && <span style={{ fontWeight: 400, color: colors.textMuted }}> — {matching} matching &ldquo;{q}&rdquo;</span>}
        </h2>
        <Link href="/network/import" style={{ ...buttonSecondary, textDecoration: "none", fontSize: 13, padding: "6px 10px" }}>
          Import people from a file
        </Link>
      </div>

      <form action="/network" method="get" style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}>
        <input
          name="q"
          defaultValue={q}
          placeholder="Search by name or where they work"
          aria-label="Search people by name or affiliation"
          style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
        />
        <button type="submit" style={buttonSecondary}>
          Search
        </button>
        {q && (
          <Link href="/network" style={{ ...buttonSecondary, textDecoration: "none" }}>
            Clear
          </Link>
        )}
      </form>

      {notice && <p style={{ fontSize: 13, margin: 0 }}>{notice}</p>}
      {error && <p style={{ color: colors.danger, fontSize: 13, margin: 0 }}>{error}</p>}

      {connections.length > 0 && (
        <div style={{ display: "flex", gap: spacing.md, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
          <label style={{ display: "flex", gap: spacing.xs, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={allOnPageChecked} onChange={(e) => togglePage(e.target.checked)} />
            Select this page ({connections.length})
          </label>
          {matching > connections.length && (
            <button type="button" style={buttonSecondary} disabled={isPending} onClick={selectAllMatching}>
              Select all {matching} {q ? "matching" : "people"}
            </button>
          )}
          {checkedIds.size > 0 && (
            <>
              <span style={{ color: colors.textMuted }}>{checkedIds.size} selected</span>
              <button type="button" style={buttonSecondary} disabled={isPending} onClick={() => setCheckedIds(new Set())}>
                Clear selection
              </button>
              {identity.available && (
                <>
                  <button type="button" style={buttonSecondary} disabled={isPending} onClick={() => markSelected(true)}>
                    Do not research ({checkedIds.size})
                  </button>
                  <button type="button" style={buttonSecondary} disabled={isPending} onClick={() => markSelected(false)}>
                    Allow research ({checkedIds.size})
                  </button>
                </>
              )}
              {!confirmOpen && (
                <button type="button" style={buttonDanger} disabled={isPending} onClick={() => setConfirmOpen(true)}>
                  Remove selected ({checkedIds.size})
                </button>
              )}
            </>
          )}
        </div>
      )}

      {confirmOpen && (
        <div style={{ display: "grid", gap: spacing.sm, ...cardStyle }}>
          <p style={{ fontSize: 13, margin: 0 }}>
            Remove {checkedIds.size} selected {checkedIds.size === 1 ? "person" : "people"} from your network? Any introduction paths suggested
            through them are removed too. This can&apos;t be undone.
          </p>
          <div style={{ display: "flex", gap: spacing.sm }}>
            <button type="button" style={buttonDanger} disabled={isPending} onClick={removeSelected}>
              {isPending ? "Removing…" : `Remove ${checkedIds.size} ${checkedIds.size === 1 ? "person" : "people"}`}
            </button>
            <button type="button" style={buttonSecondary} disabled={isPending} onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {connections.length === 0 ? (
        <div style={sectionStyle}>
          <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
            {totalRecorded === 0
              ? "No one recorded yet. Add the people your team knows — board members, donors, partners, pastors — one at a time or from a file, and the AI can look for which of them might open a door to a funder you are pursuing."
              : `No one matches “${q}”.`}
          </p>
        </div>
      ) : (
        connections.map((c) => <ConnectionCard key={c.id} connection={c} checked={checkedIds.has(c.id)} onToggle={(v) => toggle(c.id, v)} identity={identity} />)
      )}

      {matching > 0 && (
        <nav style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: spacing.sm, fontSize: 13 }} aria-label="Pages">
          {win.page > 1 ? (
            <Link href={networkHref(q, win.page - 1)} style={{ ...buttonSecondary, textDecoration: "none" }}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          <span style={{ color: colors.textMuted }}>
            {win.first}–{win.last} of {matching} · page {win.page} of {win.totalPages}
          </span>
          {win.page < win.totalPages ? (
            <Link href={networkHref(q, win.page + 1)} style={{ ...buttonSecondary, textDecoration: "none" }}>
              Next
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </section>
  );
}

export default function NetworkWorkspace({
  connections,
  totalRecorded,
  matching,
  q,
  window: win,
  identity,
}: {
  connections: NetworkConnection[];
  totalRecorded: number;
  matching: number;
  q: string;
  window: PageWindow;
  identity: IdentityPageData;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: spacing.xl, marginTop: spacing.lg }}>
      {identity.available ? (
        totalRecorded > 0 && (
          <section style={sectionStyle}>
            <div>
              <h2 style={{ fontSize: 17, margin: 0 }}>Confirm your network</h2>
              <p style={{ margin: `${spacing.xs}px 0 0`, fontSize: 13, color: colors.textMuted, maxWidth: 640 }}>
                The platform can look for who each of these people really is on the public web and propose up to three matches. You decide which is right, or
                that none is; nothing is researched about a person beyond that, and nothing is ever sent to them.
                {identity.counts && (
                  <>
                    {" "}
                    {identity.counts.confirmed} confirmed · {identity.counts.noneOfThese} none of these · {identity.counts.doNotResearch} marked do not research.
                  </>
                )}
              </p>
            </div>
            <LookupRunner eligible={identity.eligible ?? null} navigateWhenDone />
          </section>
        )
      ) : (
        <section style={sectionStyle}>
          <p style={{ margin: 0, fontSize: 13, color: colors.textMuted }}>
            Identity checks are not available yet: the network tables have not had the latest database update (migration 0083) applied. Everything else here works as before.
          </p>
        </section>
      )}

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 17, margin: 0 }}>Add someone you know</h2>
        <AddPersonSection identityAvailable={identity.available} />
      </section>

      <PeopleList
        key={`${q}|${win.page}`}
        connections={connections}
        totalRecorded={totalRecorded}
        matching={matching}
        q={q}
        window={win}
        identity={identity}
      />
    </div>
  );
}
