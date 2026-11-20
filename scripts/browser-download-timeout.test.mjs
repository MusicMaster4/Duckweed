import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchDownloadTimeout } from './browser-download-timeout.mjs';

const clamp = 'Me({timeout_ms:e.timeout_ms??12e4,max:12e4})';
const fixture = `security.assert();M("playwright_wait_for_download",async(e,t)=>{return ${clamp}});c();M("playwright_locator_download_media",async(e,t)=>{return ${clamp}});c();otherTimeout(120000);`;

test('changes only both download defaults and ceilings to one hour', () => {
  const actual = patchDownloadTimeout(fixture, 60);
  assert.equal(actual.split('max:3600000').length - 1, 2);
  assert.equal(actual.replaceAll('Me({timeout_ms:e.timeout_ms??3600000,max:3600000})', clamp), fixture);
});
test('supports 30 minutes and rejects unsupported layouts or durations', () => {
  assert.equal(patchDownloadTimeout(fixture, 30).split('max:1800000').length - 1, 2);
  assert.throws(() => patchDownloadTimeout(fixture.replace('playwright_wait_for_download', 'renamed')), /Unsupported runtime/);
  assert.throws(() => patchDownloadTimeout(fixture + clamp), /unexpected timeout layout/);
  for (const minutes of [0, 61, 1.5, NaN]) assert.throws(() => patchDownloadTimeout(fixture, minutes), /Minutes/);
});
