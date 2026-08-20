"use client";

import { useFormStatus } from "react-dom";
import LoadingStatus from "./LoadingStatus";

// Drop this inside a <form> (as a sibling to the submit button) to
// show staged progress messages while that form's action is pending.
// Reads pending state via useFormStatus, same mechanism SubmitButton
// already uses -- must be a child of the <form>, not the form itself.
export default function FormLoadingStatus({ messages }: { messages: string[] }) {
  const { pending } = useFormStatus();
  return <LoadingStatus active={pending} messages={messages} />;
}
