import { describe, expect, it } from 'vitest';
import { verifyReleasePermissions } from '../scripts/verify-release-permissions.mjs';

const manifest = { permissions: ['storage', 'activeTab', 'sidePanel'] };
describe('shipped release permission gate', () => {
  it('accepts the minimal release and statically declared scripts', () => {
    expect(() =>
      verifyReleasePermissions(manifest, {
        'drawer.js': 'chrome.storage.local.get(); chrome.sidePanel.open();',
        'content.js': 'chrome.runtime.sendMessage({});',
      }),
    ).not.toThrow();
  });
  it('rejects an unused scripting permission even when the bundle has no calls', () => {
    expect(() =>
      verifyReleasePermissions({ permissions: [...manifest.permissions, 'scripting'] }, {}),
    ).toThrow(/permissions must/);
  });
  it('rejects permissions reserved for future features', () => {
    expect(() =>
      verifyReleasePermissions({ ...manifest, optional_permissions: ['scripting'] }, {}),
    ).toThrow(/optional permissions/);
  });
  it.each([
    'chrome.scripting.executeScript({})',
    'chrome["scripting"]["executeScript"]({})',
    'chrome.tabs.captureVisibleTab()',
  ])('rejects disabled APIs in the built bundle: %s', (source) => {
    expect(() => verifyReleasePermissions(manifest, { 'drawer.js': source })).toThrow(
      /disabled scripting or capture/,
    );
  });
});
