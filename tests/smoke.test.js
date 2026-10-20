import { test, assertEqual, assertTrue } from './assert.js';

test('smoke test: basic assertions', () => {
    assertTrue(true, 'true must be truthy');
    assertEqual(1 + 1, 2, 'arithmetic addition should work');
    assertEqual('antigravity', 'antigravity', 'strings should match');
});
