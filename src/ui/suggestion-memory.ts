// prev = previously computed (stored) word; cur = current query word
export function isPureShortening(prev: string, cur: string): boolean {
  return (
    prev !== "" &&
    cur !== "" &&
    cur.length < prev.length &&
    prev.startsWith(cur)
  );
}
