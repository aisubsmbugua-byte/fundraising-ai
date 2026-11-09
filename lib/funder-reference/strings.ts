// Item 114 (ruling 0046 clause 1, the memory fix): strings that do not hold a whole
// document alive.
//
// WHY THIS EXISTS. V8 does not copy a substring of 13 or more characters; it makes a
// "sliced string" that points back into the string it was cut from. The XML reader
// cuts every name and every text out of the return it is reading, so a ten-character
// date is a copy (too short to slice) but a 25-character timestamp, a recipient name
// or a failure reason built from one keeps the ENTIRE return (often 100 KB or more)
// in memory for as long as the small string is kept. The loader keeps a few such
// strings for every return it reads in full, so a state of tens of thousands of
// returns held gigabytes of XML it had finished with. Measured in
// docs/reviews/0033-all-states-loader-build-report.md.
//
// detach() returns a string with the same characters that refers to nothing else.
// It changes no value; it changes only what stays in memory.

/** V8's shortest sliced or concatenated string; anything shorter is always a flat copy. */
const SHARES_MEMORY_FROM = 13;

export function detach(s: string): string;
export function detach(s: string | null): string | null;
export function detach(s: string | null): string | null {
  if (s === null || s.length < SHARES_MEMORY_FROM) return s;
  // Prepending a character makes V8 build a NEW flat string; slicing that gives the
  // original characters back, referring only to the new string. (A round trip through
  // a Buffer would also copy but would rewrite a lone surrogate, which a numeric
  // character reference in a return can produce: this must not change any value.)
  return (" " + s).slice(1);
}
