import type { Subscriber } from '../../types';

// Preserve the profile values while removing database object identifiers.
export function copySubscriberProfile(source: Subscriber): Subscriber {
  return JSON.parse(JSON.stringify(source, (key, value) =>
    key === '_id' || key === '__v' ? undefined : value,
  )) as Subscriber;
}

export function copiedValueConflict(value: string | string[] | undefined, original: string | string[] | undefined): boolean {
  const values = (Array.isArray(value) ? value : [value ?? '']).map(v => v.trim().toLowerCase()).filter(Boolean);
  const originals = new Set((Array.isArray(original) ? original : [original ?? '']).map(v => v.trim().toLowerCase()).filter(Boolean));
  return values.some(v => originals.has(v));
}
