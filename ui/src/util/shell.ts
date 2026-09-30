/**
 * A job name as one shell word, for the `auto run <name>` hints the page
 * offers to copy. Names may hold spaces and non-ASCII letters, which an
 * unquoted command line would split or mangle. Plain names stay bare.
 */
export function shellWord(name: string): string {
  if (/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)) return name;
  return `'${name.replaceAll("'", `'\\''`)}'`;
}
