// This is an explicit release baseline, not a general proof of API reachability.
// Re-enabling selection requires a deliberate permission and runtime review.
export const verifyReleasePermissions = (manifest, sources) => {
  const expected = ['activeTab', 'sidePanel', 'storage'];
  const actual = [...(manifest.permissions ?? [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Release permissions must be exactly storage, activeTab, sidePanel');
  if (manifest.optional_permissions?.length)
    throw new Error('Release must not reserve optional permissions');
  for (const [file, source] of Object.entries(sources)) {
    if (/\bscripting\b|\bexecuteScript\b|\bcaptureVisibleTab\b/.test(source))
      throw new Error(`${file} contains disabled scripting or capture APIs`);
  }
};
