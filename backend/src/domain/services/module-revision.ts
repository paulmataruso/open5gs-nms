// Staleness for the optional modules, keyed on what the module's own code
// actually does — not on the app's version string.
//
// Why this exists
// ---------------
// Every optional module used to record `getAppVersion()` at install/configure
// time and report itself stale whenever that differed from the running app
// version. So cutting any release — a docs fix, an unrelated module's bug fix —
// marked every installed module out of date and put the "Updates available"
// prompt in front of the operator with nothing real to do. Worse, the signal
// was both too loud and too quiet: too loud because unrelated releases tripped
// it, and too quiet because editing a module's own config generator WITHOUT
// bumping the app version left it reporting itself current.
//
// Three modules already did this properly and are the model here: VoWiFi
// (VECTORCORE_PATCH_REV / VOWIFI_CONFIG_GEN_VERSION), SecGW (SECGW_PATCH_REV /
// SECGW_CONFIG_GEN_VERSION) and the Kamailio source build (KAMAILIO_PATCH_REV).
// They stayed correctly silent through the releases that made everything else
// shout, which is exactly the behaviour being generalised.
//
// The rule
// --------
// Each module owns two integers next to its own code:
//
//   <MODULE>_INSTALL_REV — bump when the INSTALL steps change in a way an
//                          existing deployment must re-run to pick up (a new
//                          package, a new patch, a changed build).
//   <MODULE>_CONFIG_REV  — bump when the CONFIG GENERATOR changes, so a
//                          deployment's on-disk config no longer matches what
//                          this code would now write.
//
// Do NOT bump either for an unrelated release. Bumping is how you ask every
// operator to re-run something, so it should be a deliberate decision.
//
// A recorded revision of null/undefined counts as stale: it means the module was
// installed or configured before the revision was tracked, so we genuinely do
// not know whether it matches. Prompting once is honest; assuming it is current
// would hide a real mismatch.
//
// This is deliberately separate from CONTENT-based checks, which are stronger
// where they are available — see checkImsTemplateStaleness(), which compares the
// deployed Kamailio routing scripts byte for byte. A revision says "the code
// that writes this changed"; a content check says "what is on disk differs".
// Use both: the revision catches a changed generator whose output happens to be
// identical today, and the content check catches drift the revision cannot see
// (a hand edit, a partial redeploy).

export interface RevisionStaleness {
  installStale: boolean;
  configStale: boolean;
}

export function revisionStaleness(opts: {
  /** Is the module installed on disk at all? */
  installed: boolean;
  /** Has the module ever been configured (i.e. is there saved config)? */
  hasSavedConfig: boolean;
  installedWithRev?: number | null;
  configuredWithRev?: number | null;
  expectedInstallRev: number;
  expectedConfigRev: number;
}): RevisionStaleness {
  return {
    // Only meaningful for something actually installed; an absent module is not
    // "stale", it is simply not there.
    installStale: opts.installed && opts.installedWithRev !== opts.expectedInstallRev,
    // Likewise, never-configured is not stale — there is nothing to bring up to
    // date, and the module's own page is where you'd configure it.
    configStale: opts.hasSavedConfig && opts.configuredWithRev !== opts.expectedConfigRev,
  };
}
