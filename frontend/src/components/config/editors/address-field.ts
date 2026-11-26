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
