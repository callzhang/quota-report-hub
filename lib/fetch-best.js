export function shouldReturnInvalidatedUploaderEntry(invalidatedEntry, { allowInvalidatedReauth = true } = {}) {
  return Boolean(invalidatedEntry && allowInvalidatedReauth);
}
