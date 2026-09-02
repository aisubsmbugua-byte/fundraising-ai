// Liveness, plus WHICH CODE is live.
//
// This returned { ok: true } and nothing else, which cannot answer the
// question that actually matters when behaviour looks wrong: is the
// deployment running the fix? A research run finished three minutes before a
// verification fix shipped, was correctly stored under the old rule, and
// looked like a broken button for the rest of the evening -- the run row's
// own code_version is what settled it, and there was no way to ask the same
// question of the deployment itself.
//
// Deliberately unauthenticated and deliberately minimal: a commit SHA and a
// branch. No configuration, no environment values, nothing about the
// database. Build identity is not a secret; anything that is stays out.
export async function GET() {
  return Response.json({
    ok: true,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? "local",
    environment: process.env.VERCEL_ENV ?? "development",
  });
}
