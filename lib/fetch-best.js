export function shouldReturnInvalidatedUploaderEntry(invalidatedEntry, currentAccountId) {
  return Boolean(
    invalidatedEntry &&
    invalidatedEntry.account_id !== currentAccountId
  );
}
