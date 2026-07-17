import { useCallback } from 'react';

// The modern Clipboard API only works in "secure contexts" — HTTPS or
// localhost (https://w3c.github.io/webappsec-secure-contexts/). This app's
// main UI is served over plain HTTP on a LAN IP (see nginx.conf, port 80,
// no SSL — the SSL listeners are only for radio ACS/SAS connections, not the
// browser-facing UI), so `navigator.clipboard` is undefined for every user
// of this app and every copy button silently does nothing. The legacy
// `document.execCommand('copy')` approach still works over plain HTTP, so it
// covers the actual deployment; the Clipboard API is tried first only in
// case this is ever served over HTTPS/localhost too.
async function writeToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy fallback below
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Keep it in the viewport (off-screen elements can't be selected in
    // some browsers) but invisible and non-disruptive.
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** Returns a stable `copy(text)` function that resolves to whether the copy actually succeeded. */
export function useCopyToClipboard() {
  return useCallback((text: string): Promise<boolean> => writeToClipboard(text), []);
}
