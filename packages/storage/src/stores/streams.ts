/** Wraps a synchronous iterable as an AsyncIterable (useful for in-memory adapters and tests). */
export function toAsyncIterable<T>(iterable: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const it = iterable[Symbol.iterator]();
      return {
        next: () => Promise.resolve(it.next()),
      };
    },
  };
}
