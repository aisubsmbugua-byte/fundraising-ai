"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = 'input, select, textarea, button[type="submit"]';
const SINGLE_LINE_TYPES = ["text", "number", "email", "url", "tel", "search"];

// Drop this anywhere inside a <form>. On Enter in a single-line input
// (not textareas -- those need real newlines, and not the submit
// button), moves focus to the next field instead of submitting the
// form early.
export default function EnterAdvancesFocus() {
  const markerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const form = markerRef.current?.closest("form");
    if (!form) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter") return;
      const target = e.target as HTMLElement;
      if (target.tagName !== "INPUT") return;
      const input = target as HTMLInputElement;
      if (!SINGLE_LINE_TYPES.includes(input.type)) return;

      e.preventDefault();

      const focusable = Array.from(form!.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1
      );
      const currentIndex = focusable.indexOf(input);
      const next = focusable[currentIndex + 1];
      next?.focus();
    }

    form.addEventListener("keydown", handleKeyDown);
    return () => form.removeEventListener("keydown", handleKeyDown);
  }, []);

  return <div ref={markerRef} style={{ display: "none" }} />;
}
