// Values that must NOT reach the entry module's export list.
//
// `index.ts` re-exports everything from `book.ts` so the Durable Object and the entrypoint classes
// are visible to the runtime, and workerd requires every named export of the entry module to be a
// function or an ExportedHandler. A re-exported string constant fails at startup with
// "Incorrect type for map entry ...: the provided value is not of type 'function or
// ExportedHandler'" -- a runtime error no dry-run or unit test catches. Constants live here, and
// `index.ts` imports them without re-exporting.

/** The name of the one Book Durable Object. The mirror is deployment-wide, not per-user. */
export const BOOK_SINGLETON = "book";
