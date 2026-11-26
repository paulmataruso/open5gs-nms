// Helpers for editing an Open5GS `address` / `advertise` / `local_address`
// field, every one of which is `string | string[]` because Open5GS lets an NF
// bind a single address or a list.
//
// Rendering a list straight into an <input> displays "a, b" and then writes
// that joined string back as ONE bogus address, silently collapsing the list.
// That is a real data-loss path, not a cosmetic issue, and it was invisible
// while the editors cast their config to `any`. These two functions carry
// list-ness across the round trip instead.
//
// Pure and dependency-free on purpose: no React, no types import, so a test in
// either workspace can exercise them.

/** Render an address field for display in a text input. */
export function addressToText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

/**
 * Write an edited address field back.
 *
 * `wasList` must come from the value being replaced: a file that declared one
 * address keeps declaring one, and a file that declared a list keeps a list,
 * so editing never changes the field's SHAPE -- only its contents. Deriving
 * list-ness from the typed text instead would silently convert a scalar field
 * to a list the moment someone typed a comma.
 */
export function textToAddress(text: string, wasList: boolean): string | string[] {
  if (!wasList) return text;
  return text.split(',').map((a) => a.trim()).filter(Boolean);
}

/** True when the value being edited is a list, for pairing with textToAddress. */
export function isAddressList(value: string | string[] | undefined): boolean {
  return Array.isArray(value);
}

/**
 * The single representative address, for LOGIC rather than display: "is this
 * loopback", "is this one of our local UPFs", and so on.
 *
 * Distinct from addressToText() on purpose. Joining a list for a predicate
 * would hand `isLoopback()` the string "127.0.0.1, 10.0.0.1", which is neither
 * loopback nor routable and would quietly answer the wrong thing. Open5GS
 * treats the first entry as the primary bind address, which is also what the
 * backend's own addrOf() in auto-config.ts does -- keep the two consistent.
 */
export function firstAddress(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}
