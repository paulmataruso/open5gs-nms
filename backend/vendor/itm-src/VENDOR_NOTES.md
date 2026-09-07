# NTIA ITM (Longley-Rice) — vendored C++ source

Source: https://github.com/NTIA/itm
Pinned commit: 183ad95bd813a8be11009df396e1c631356864b2
Commit date: 2024-09-24 16:42:27 -0400
License: NTIA/ITS open-source license (U.S. government work, public domain —
free use/modify/redistribute, attribution requested, no warranty). See
upstream LICENSE.md at the URL above for the authoritative text.

## Patches applied (build-portability only, no algorithm changes)

1. **Include path separators**: every `src/*.cpp` file used Windows-style
   backslash includes (`"..\include\itm.h"`) — on Linux/Clang, a backslash
   is a literal character, not a path separator, so these failed to resolve
   at all. Replaced with forward slashes (`"../include/itm.h"`) via a
   mechanical sed pass — same include target, same files, no semantic change.
2. Compiled with `-fdeclspec` (see build-wasm.sh) so Clang accepts the
   `__declspec(dllexport)` MSVC attribute used by the `DLLEXPORT` macro in
   `include/itm.h` — it's silently ignored (harmless; WASM builds don't need
   Windows DLL export semantics, and the `extern "C"` half of that same
   macro, which does matter for linkage, is unaffected).

`win32/` (the Windows GUI driver, not needed for any WASM build) was removed
from this vendored copy — it depends on Windows-only headers and isn't part
of the actual ITM algorithm.

Re-vendoring: re-clone from the URL above, check out the same or a newer
commit, delete `win32/` and `.git/`, and reapply patch 1 with:
`sed -i 's#\.\.\\include\\\([A-Za-z]*\.h\)#../include/\1#g' src/*.cpp`
