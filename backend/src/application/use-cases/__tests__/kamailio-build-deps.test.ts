import { BUILD_APT_DEPS } from '../kamailio-source-build';

// Regression guard for a real clean-host build failure, 2026-11-08: the
// Kamailio 6.0.8 source build died after ~10 minutes of compiling with
//   json_funcs.c:26:10: fatal error: json.h: No such file or directory
//   make[1]: *** [Makefile:510: modules] Error 1
// because json-c's headers were not installed.
//
// The trap is that libjansson-dev WAS already in this list and is genuinely
// needed by other modules — two different JSON libraries, both required — so
// the omission looked covered. `kamailio-json-modules` is installed from apt,
// which puts the `json` module in the enabled build set, so it cannot just be
// skipped either.
describe('Kamailio source-build apt dependencies', () => {
  it('includes json-c, which the json module\'s #include <json.h> needs', () => {
    expect(BUILD_APT_DEPS).toContain('libjson-c-dev');
  });

  it('still includes jansson, a DIFFERENT library other modules need', () => {
    // Guards against "fixing" this by swapping one for the other.
    expect(BUILD_APT_DEPS).toContain('libjansson-dev');
  });

  it('includes the toolchain and parser generators the build shells out to', () => {
    for (const dep of ['build-essential', 'bison', 'flex', 'pkg-config']) {
      expect(BUILD_APT_DEPS).toContain(dep);
    }
  });

  it('includes the IMS/SIP transport headers the CSCF modules need', () => {
    for (const dep of ['libxml2-dev', 'libsctp-dev', 'libssl-dev', 'libcurl4-openssl-dev']) {
      expect(BUILD_APT_DEPS).toContain(dep);
    }
  });

  it('lists no duplicates, which would make the apt line needlessly fragile', () => {
    expect(new Set(BUILD_APT_DEPS).size).toBe(BUILD_APT_DEPS.length);
  });

  it('names only real package names — no empty or whitespace entries', () => {
    for (const dep of BUILD_APT_DEPS) {
      expect(dep).toMatch(/^[a-z0-9][a-z0-9.+-]*$/);
    }
  });
});
