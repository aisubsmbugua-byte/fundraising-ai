// Every row, not the first thousand.
//
// PostgREST caps an unbounded select at 1000 rows and returns them with no
// error and no marker -- the caller gets a short array that looks complete.
// This is a quiet, total failure mode for any measurement: pipeline-readiness
// reported "identity resolved, no claims extracted" for four prospects whose
// claims simply fell past row 1000, and nothing anywhere said so.
//
// Two properties matter here. It pages until the source is exhausted, and it
// takes an expected `count` so a short read is an ERROR rather than a smaller
// number. A tool that silently under-reports is worse than one that fails: the
// failure gets fixed, and the under-report gets quoted in a decision.

const PAGE = 1000;

// Deliberately structural rather than importing PostgREST's builder generics:
// this only needs "something rangeable that resolves to rows", and pinning the
// full generic signature makes the helper harder to call than the bug it
// prevents is to reintroduce.
type Rangeable<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }> & {
  range(from: number, to: number): Rangeable<T>;
};

export async function fetchAllRows<T>(
  // A builder for the query WITHOUT any range applied -- this adds its own.
  // Passed as a factory because a PostgREST builder is single-use: reusing one
  // across pages silently returns the first page every time.
  build: () => Rangeable<T>,
  // Total the table reports for this filter, fetched by the caller with
  // { count: "exact", head: true }. Passed in rather than derived here because
  // re-deriving it would need the builder's own filters reapplied, and a count
  // that does not match the query it guards is worse than none.
  expected: number | null,
  label: string
): Promise<T[]> {

  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  // The whole point. A measurement that quietly lost rows must not be usable.
  if (typeof expected === "number" && rows.length !== expected) {
    throw new Error(`${label}: read ${rows.length} rows but the table reports ${expected}. Refusing to report on a partial read.`);
  }
  return rows;
}
