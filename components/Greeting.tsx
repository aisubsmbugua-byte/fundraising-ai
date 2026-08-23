"use client";

import { useEffect, useState } from "react";

// Deliberately computed client-side, not passed down as a server-
// resolved prop -- Vercel's serverless functions run in UTC, so a
// server-computed "Good morning/afternoon/evening" reflected the
// server's clock, not wherever the visitor actually is (could say
// "Good morning" at 6pm local time). Starts at a neutral fallback and
// fills in the real one-time-of-day-accurate greeting after mount, so
// server and client render the same thing initially (no hydration
// mismatch) -- the gap before the effect runs is sub-100ms, not
// perceptible in practice.
export default function Greeting({ name }: { name: string }) {
  const [timeGreeting, setTimeGreeting] = useState<string | null>(null);

  useEffect(() => {
    const hour = new Date().getHours();
    setTimeGreeting(hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
  }, []);

  return (
    <>
      {timeGreeting ?? "Hello"}, {name}
    </>
  );
}
