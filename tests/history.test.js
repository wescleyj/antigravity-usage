import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    test,
    assertEqual,
    assertAlmostEqual,
    assertTrue,
    assertThrows,
} from './assert.js';
import {
    formatDuration,
    UsageHistoryStore,
    HistoryStore,
    sanitizeSettings,
    MAX_BUCKETS,
    BUCKET_ID_REGEX,
    FORBIDDEN_KEYS,
} from '../src/lib/history.js';

function getTempTestFile() {
    const tmpDir = GLib.build_filenamev([GLib.get_tmp_dir(), 'antigravity-test-' + Math.random().toString(36).substring(2)]);
    return GLib.build_filenamev([tmpDir, 'history.json']);
}

// -------------------------------------------------------------------------
// formatDuration tests
// -------------------------------------------------------------------------
test('formatDuration: handles <= 0 and invalid values with Agora', () => {
    assertEqual(formatDuration(0), 'Agora', '0 ms should return Agora');
    assertEqual(formatDuration(-1000), 'Agora', 'negative ms should return Agora');
    assertEqual(formatDuration(null), 'Agora', 'null should return Agora');
    assertEqual(formatDuration(undefined), 'Agora', 'undefined should return Agora');
    assertEqual(formatDuration(NaN), 'Agora', 'NaN should return Agora');
    assertEqual(formatDuration(Infinity), 'Agora', 'Infinity should return Agora');
});

test('formatDuration: formats < 1m correctly', () => {
    assertEqual(formatDuration(1000), '< 1m', '1s should be < 1m');
    assertEqual(formatDuration(30000), '< 1m', '30s should be < 1m');
    assertEqual(formatDuration(59999), '< 1m', '59.9s should be < 1m');
});

test('formatDuration: formats minutes correctly', () => {
    assertEqual(formatDuration(60000), '1m', '60s should be 1m');
    assertEqual(formatDuration(38 * 60 * 1000), '38m', '38 minutes should be 38m');
    assertEqual(formatDuration(59 * 60 * 1000 + 45000), '59m', '59m45s should be 59m');
});

test('formatDuration: formats hours and minutes correctly', () => {
    assertEqual(formatDuration(4 * 3600 * 1000 + 15 * 60 * 1000), '4h 15m', '4h 15m format');
    assertEqual(formatDuration(4 * 3600 * 1000), '4h', 'Exact 4h should omit 0m');
    assertEqual(formatDuration(23 * 3600 * 1000 + 59 * 60 * 1000), '23h 59m', '23h 59m format');
});

test('formatDuration: formats days and hours correctly', () => {
    assertEqual(formatDuration(2 * 86400 * 1000 + 7 * 3600 * 1000), '2d 7h', '2d 7h format');
    assertEqual(formatDuration(2 * 86400 * 1000), '2d', 'Exact 2d should omit 0h');
    assertEqual(formatDuration(7 * 86400 * 1000 + 12 * 3600 * 1000), '7d 12h', '7d 12h format');
});

// -------------------------------------------------------------------------
// UsageHistoryStore Initialization and Settings tests
// -------------------------------------------------------------------------
test('UsageHistoryStore: creates parent directory and sets default settings', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    const settings = store.getSettings();
    assertEqual(settings.reloadMode, 'auto', 'default reloadMode should be auto');
    assertEqual(settings.autoActiveSec, 180, 'default autoActiveSec should be 180');
    assertEqual(settings.autoIdleSec, 1800, 'default autoIdleSec should be 1800');
    assertEqual(settings.showPanelPercent, true, 'default showPanelPercent should be true');

    const parentDir = GLib.path_get_dirname(testFile);
    assertTrue(GLib.file_test(parentDir, GLib.FileTest.IS_DIR), 'parent directory should exist');
});

test('UsageHistoryStore: alias HistoryStore is identical', () => {
    assertEqual(HistoryStore, UsageHistoryStore, 'HistoryStore should be an alias of UsageHistoryStore');
});

test('UsageHistoryStore: updateSettings persists and reloads correctly', () => {
    const testFile = getTempTestFile();
    const store1 = new UsageHistoryStore(testFile);

    store1.updateSettings({
        reloadMode: 300,
        autoActiveSec: 120,
        showPanelPercent: false,
    });

    const settings1 = store1.getSettings();
    assertEqual(settings1.reloadMode, 300, 'updated reloadMode');
    assertEqual(settings1.autoActiveSec, 120, 'updated autoActiveSec');
    assertEqual(settings1.autoIdleSec, 1800, 'autoIdleSec preserved');
    assertEqual(settings1.showPanelPercent, false, 'updated showPanelPercent');

    // Create a new instance pointing to the same file to verify persistence
    const store2 = new UsageHistoryStore(testFile);
    const settings2 = store2.getSettings();
    assertEqual(settings2.reloadMode, 300, 'persisted reloadMode');
    assertEqual(settings2.autoActiveSec, 120, 'persisted autoActiveSec');
    assertEqual(settings2.autoIdleSec, 1800, 'persisted autoIdleSec');
    assertEqual(settings2.showPanelPercent, false, 'persisted showPanelPercent');
});

// -------------------------------------------------------------------------
// recordSample tests (Deduplication, Reset detection, Pruning)
// -------------------------------------------------------------------------
test('recordSample: basic insertion and persistence', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const now = 1700000000000;
    const resetTime = '2026-10-22T01:17:49Z';

    const recorded = store.recordSample('gemini-weekly', 0.95, resetTime, now);
    assertTrue(recorded, 'first sample should be recorded');

    const store2 = new UsageHistoryStore(testFile);
    const analysis = store2.analyzeBucket({ bucketId: 'gemini-weekly', nowMs: now });
    assertEqual(analysis.sampleCount, 1, 'persisted sample count should be 1');
    assertAlmostEqual(analysis.remainingFraction, 0.95, 1e-4, 'remainingFraction preserved');
});

test('recordSample: deduplication when delta < 0.0001, same resetTime and dt < 10min', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    const resetTime = '2026-10-22T01:17:49Z';

    const res1 = store.recordSample('gemini-weekly', 0.95000, resetTime, t0);
    assertTrue(res1, 'sample 1 recorded');

    // Delta = 0.00005 (< 0.0001), dt = 5min (< 10min), same resetTime -> Deduplicate
    const res2 = store.recordSample('gemini-weekly', 0.95005, resetTime, t0 + 5 * 60 * 1000);
    assertEqual(res2, false, 'sample 2 should be deduplicated');

    let analysis = store.analyzeBucket({ bucketId: 'gemini-weekly', nowMs: t0 + 5 * 60 * 1000 });
    assertEqual(analysis.sampleCount, 1, 'sampleCount must remain 1');

    // After 11 minutes (dt >= 10min), should record even if same fraction
    const res3 = store.recordSample('gemini-weekly', 0.95005, resetTime, t0 + 11 * 60 * 1000);
    assertTrue(res3, 'sample 3 recorded because dt >= 10min');

    analysis = store.analyzeBucket({ bucketId: 'gemini-weekly', nowMs: t0 + 11 * 60 * 1000 });
    assertEqual(analysis.sampleCount, 2, 'sampleCount must be 2');

    // Within 5 min but delta >= 0.0001 -> should record
    const res4 = store.recordSample('gemini-weekly', 0.94900, resetTime, t0 + 13 * 60 * 1000);
    assertTrue(res4, 'sample 4 recorded because delta >= 0.0001');

    analysis = store.analyzeBucket({ bucketId: 'gemini-weekly', nowMs: t0 + 13 * 60 * 1000 });
    assertEqual(analysis.sampleCount, 3, 'sampleCount must be 3');
});

test('recordSample: detects cycle reset when remainingFraction - last.r > 0.02 and clears previous cycle', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    const resetOld = '2026-10-22T01:17:49Z';
    const resetNew = '2026-10-29T01:17:49Z';

    store.recordSample('gemini-weekly', 0.50, resetOld, t0);
    store.recordSample('gemini-weekly', 0.20, resetOld, t0 + 3600000);

    let analysis = store.analyzeBucket({ bucketId: 'gemini-weekly', nowMs: t0 + 3600000 });
    assertEqual(analysis.sampleCount, 2, '2 samples before reset');

    // New sample with quota jump from 0.20 to 1.00 (> 0.02)
    const resReset = store.recordSample('gemini-weekly', 1.00, resetNew, t0 + 7200000);
    assertTrue(resReset, 'reset sample recorded');

    analysis = store.analyzeBucket({ bucketId: 'gemini-weekly', nowMs: t0 + 7200000 });
    assertEqual(analysis.sampleCount, 1, 'previous cycle cleared; only new sample remains');
    assertAlmostEqual(analysis.remainingFraction, 1.00, 1e-4, 'remainingFraction is 1.00');
});

test('recordSample: pruning samples older than 8 days and capping at 500 samples', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const now = 1700000000000;
    const resetTime = '2026-10-22T01:17:49Z';
    const eightDaysMs = 8 * 24 * 3600 * 1000;

    // Insert an old sample (9 days ago)
    store.recordSample('gemini-weekly', 0.99, resetTime, now - eightDaysMs - 3600000);

    // Insert a valid sample within 8 days
    store.recordSample('gemini-weekly', 0.95, resetTime, now - 3600000);

    // Insert a current sample
    store.recordSample('gemini-weekly', 0.90, resetTime, now);

    const analysis = store.analyzeBucket({ bucketId: 'gemini-weekly', nowMs: now });
    assertEqual(analysis.sampleCount, 2, 'sample older than 8 days was pruned');

    // Test capping at 500 samples
    for (let i = 0; i < 510; i++) {
        // use distinct fraction and timestamps to avoid deduplication
        store.recordSample('gemini-5h', (i % 100) / 100, resetTime, now + (i + 1) * 600000);
    }

    const analysis5h = store.analyzeBucket({ bucketId: 'gemini-5h', nowMs: now + 511 * 600000 });
    assertEqual(analysis5h.sampleCount, 500, 'must be capped at max 500 samples');
});

// -------------------------------------------------------------------------
// analyzeBucket Burn Rate & Autonomy tests
// -------------------------------------------------------------------------
test('analyzeBucket: returns complete contract fields', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const now = 1700000000000;
    const resetTime = new Date(now + 4 * 3600 * 1000).toISOString();

    const analysis = store.analyzeBucket({
        bucketId: 'gemini-5h',
        remainingFraction: 0.80,
        resetTimeIso: resetTime,
        windowType: '5h',
        nowMs: now,
    });

    assertEqual(analysis.bucketId, 'gemini-5h', 'bucketId');
    assertEqual(analysis.windowType, '5h', 'windowType');
    assertAlmostEqual(analysis.remainingFraction, 0.80, 1e-4, 'remainingFraction');
    assertAlmostEqual(analysis.usedFraction, 0.20, 1e-4, 'usedFraction');
    assertAlmostEqual(analysis.remainingPercent, 80.0, 1e-2, 'remainingPercent');
    assertAlmostEqual(analysis.usedPercent, 20.0, 1e-2, 'usedPercent');
    assertEqual(analysis.resetTimeIso, resetTime, 'resetTimeIso');
    assertEqual(analysis.resetInMs, 4 * 3600 * 1000, 'resetInMs');
    assertEqual(analysis.resetInFormatted, '4h', 'resetInFormatted');
    assertTrue('burnPercentPerHour' in analysis, 'has burnPercentPerHour');
    assertTrue('burnPercentPerDay' in analysis, 'has burnPercentPerDay');
    assertTrue('estimatedDurationMs' in analysis, 'has estimatedDurationMs');
    assertTrue('estimatedDurationFormatted' in analysis, 'has estimatedDurationFormatted');
    assertTrue('estimatedLabel' in analysis, 'has estimatedLabel');
    assertTrue('willExhaustBeforeReset' in analysis, 'has willExhaustBeforeReset');
    assertTrue('sampleCount' in analysis, 'has sampleCount');
});

test('analyzeBucket: cycleBurnPerHour calculation for 5h and weekly windows', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const now = 1700000000000;

    // Window 5h: reset in 3h -> elapsed is 2h. Used fraction is 0.20 (20%).
    // Cycle burn per hour = 0.20 / 2h = 0.10/h (10% per hour).
    const reset5h = new Date(now + 3 * 3600 * 1000).toISOString();
    const analysis5h = store.analyzeBucket({
        bucketId: 'test-5h',
        remainingFraction: 0.80,
        resetTimeIso: reset5h,
        windowType: '5h',
        nowMs: now,
    });
    // With 0 samples in history, effective = cycleBurn = 0.10/h -> 10% per hour
    assertAlmostEqual(analysis5h.burnPercentPerHour, 10.0, 1e-3, 'burnPercentPerHour for 5h');
    assertAlmostEqual(analysis5h.burnPercentPerDay, 240.0, 1e-2, 'burnPercentPerDay for 5h');

    // Window weekly (168h): reset in 144h -> elapsed is 24h. Used fraction is 0.12 (12%).
    // Cycle burn per hour = 0.12 / 24h = 0.005/h (0.5% per hour).
    const resetWeekly = new Date(now + 144 * 3600 * 1000).toISOString();
    const analysisWeekly = store.analyzeBucket({
        bucketId: 'test-weekly',
        remainingFraction: 0.88,
        resetTimeIso: resetWeekly,
        windowType: 'weekly',
        nowMs: now,
    });
    assertAlmostEqual(analysisWeekly.burnPercentPerHour, 0.5, 1e-3, 'burnPercentPerHour for weekly');
    assertAlmostEqual(analysisWeekly.burnPercentPerDay, 12.0, 1e-2, 'burnPercentPerDay for weekly');
});

test('analyzeBucket: hybrid burn rate combining 65% history and 35% cycle', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    const nowMs = t0 + 30 * 60 * 1000;
    // Window 5h with exactly 1h elapsed at nowMs -> reset in 4h
    const resetTime = new Date(nowMs + 4 * 3600 * 1000).toISOString();

    // 1h elapsed in 5h window: used is 0.10 (10%).
    // cycleBurnPerHour = 0.10 / 1h = 0.10 (10%/h).

    // History: sample at t0: 0.95, sample at t0 + 30m: 0.90
    // dt = 30m = 0.5h (>= 3m). dr = 0.05.
    // historyBurnPerHour = 0.05 / 0.5h = 0.10 (10%/h).
    store.recordSample('gemini-5h', 0.95, resetTime, t0);
    store.recordSample('gemini-5h', 0.90, resetTime, nowMs);

    // Hybrid = 0.65 * 0.10 + 0.35 * 0.10 = 0.10 (10%/h).
    const analysis = store.analyzeBucket({
        bucketId: 'gemini-5h',
        remainingFraction: 0.90,
        resetTimeIso: resetTime,
        windowType: '5h',
        nowMs: nowMs,
    });

    assertAlmostEqual(analysis.burnPercentPerHour, 10.0, 1e-2, 'hybrid burn rate is 10%/h');
    assertAlmostEqual(analysis.burnPercentPerDay, 240.0, 1e-1, 'hybrid burn rate per day');
});

test('analyzeBucket: history burn ignored if dt < 3 minutes', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    const nowMs = t0 + 2 * 60 * 1000;
    // Window 5h with exactly 1h elapsed at nowMs -> reset in 4h
    const resetTime = new Date(nowMs + 4 * 3600 * 1000).toISOString();

    // 2 samples separated by only 2 minutes (< 3m)
    store.recordSample('gemini-5h', 0.95, resetTime, t0);
    store.recordSample('gemini-5h', 0.90, resetTime, nowMs);

    // Since dt < 3m, historyBurn is 0. effectiveBurn is 100% cycleBurn.
    // 5h window, reset in 4h -> 1h elapsed. Used = 0.10. cycleBurn = 0.10 / 1h = 0.10/h (10%/h).
    const analysis = store.analyzeBucket({
        bucketId: 'gemini-5h',
        remainingFraction: 0.90,
        resetTimeIso: resetTime,
        windowType: '5h',
        nowMs: nowMs,
    });

    assertAlmostEqual(analysis.burnPercentPerHour, 10.0, 1e-2, 'burnPercentPerHour should fallback to cycle rate');
});

test('analyzeBucket: detects quota exhaustion before reset (willExhaustBeforeReset = true)', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    // Reset in 10 hours
    const resetTime = new Date(t0 + 10 * 3600 * 1000).toISOString();

    // Remaining: 0.20 (20%). Burn rate: 0.05/h (5% per hour).
    // Autonomy = 0.20 / 0.05 = 4 hours.
    // Since 4h < 10h (reset), it will exhaust before reset!
    // Setup history: 1 hour ago r = 0.25, now r = 0.20. dt = 1h, dr = 0.05.
    // cycle burn for weekly window (168h): reset in 10h -> elapsed 158h. used = 0.80. cycle = 0.80 / 158 = 0.00506.
    // historyBurn = 0.05.
    // effectiveBurn = 0.65 * 0.05 + 0.35 * 0.00506 = 0.0325 + 0.00177 = 0.03427/h.
    // Autonomy = 0.20 / 0.03427 = 5.83h < 10h.
    store.recordSample('gemini-weekly', 0.25, resetTime, t0 - 3600 * 1000);
    store.recordSample('gemini-weekly', 0.20, resetTime, t0);

    const analysis = store.analyzeBucket({
        bucketId: 'gemini-weekly',
        remainingFraction: 0.20,
        resetTimeIso: resetTime,
        windowType: 'weekly',
        nowMs: t0,
    });

    assertTrue(analysis.willExhaustBeforeReset, 'must flag willExhaustBeforeReset = true');
    assertEqual(analysis.estimatedLabel, 'Esgota antes do reset', 'estimatedLabel');
    assertTrue(analysis.estimatedDurationMs < analysis.resetInMs, 'durationMs < resetInMs');
});

test('analyzeBucket: detects safe usage until reset (willExhaustBeforeReset = false)', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    // Reset in 2 hours
    const resetTime = new Date(t0 + 2 * 3600 * 1000).toISOString();

    // Remaining: 0.80 (80%). Autonomy is much larger than 2 hours.
    store.recordSample('gemini-weekly', 0.85, resetTime, t0 - 3600 * 1000);
    store.recordSample('gemini-weekly', 0.80, resetTime, t0);

    const analysis = store.analyzeBucket({
        bucketId: 'gemini-weekly',
        remainingFraction: 0.80,
        resetTimeIso: resetTime,
        windowType: 'weekly',
        nowMs: t0,
    });

    assertEqual(analysis.willExhaustBeforeReset, false, 'willExhaustBeforeReset must be false');
    assertEqual(analysis.estimatedLabel, 'Seguro até o reset', 'estimatedLabel');
    assertTrue(analysis.estimatedDurationMs >= analysis.resetInMs, 'durationMs >= resetInMs');
});

test('analyzeBucket: handles zero consumption and exhausted quota gracefully', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    const resetTime = new Date(t0 + 2 * 3600 * 1000).toISOString();

    // 100% remaining, zero used
    const analysisFull = store.analyzeBucket({
        bucketId: 'gemini-weekly',
        remainingFraction: 1.0,
        resetTimeIso: resetTime,
        windowType: 'weekly',
        nowMs: t0,
    });
    assertEqual(analysisFull.burnPercentPerHour, 0, 'burn is 0');
    assertEqual(analysisFull.willExhaustBeforeReset, false, 'not exhausting');
    assertEqual(analysisFull.estimatedLabel, 'Seguro até o reset', 'safe label');
    assertEqual(analysisFull.estimatedDurationMs, null, 'estimatedDurationMs is null');
    assertEqual(analysisFull.estimatedDurationFormatted, null, 'estimatedDurationFormatted is null');

    // 0% remaining (exhausted)
    const analysisExhausted = store.analyzeBucket({
        bucketId: 'gemini-weekly',
        remainingFraction: 0.0,
        resetTimeIso: resetTime,
        windowType: 'weekly',
        nowMs: t0,
    });
    assertEqual(analysisExhausted.remainingPercent, 0, 'remainingPercent is 0');
    assertEqual(analysisExhausted.usedPercent, 100, 'usedPercent is 100');
    assertEqual(analysisExhausted.estimatedLabel, 'Esgotado', 'label is Esgotado');
    assertEqual(analysisExhausted.estimatedDurationMs, 0, 'duration is 0');
    assertEqual(analysisExhausted.estimatedDurationFormatted, 'Agora', 'formatted is Agora');
});

test('UsageHistoryStore: respects ANTIGRAVITY_USAGE_HISTORY_PATH env variable', () => {
    const testFile = getTempTestFile();
    GLib.setenv('ANTIGRAVITY_USAGE_HISTORY_PATH', testFile, true);

    const store = new UsageHistoryStore();
    store.updateSettings({ reloadMode: 60 });

    const storeCheck = new UsageHistoryStore(testFile);
    assertEqual(storeCheck.getSettings().reloadMode, 60, 'read from env path');

    GLib.unsetenv('ANTIGRAVITY_USAGE_HISTORY_PATH');
});

test('UsageHistoryStore: recovers safely from corrupted JSON file', () => {
    const testFile = getTempTestFile();
    const dir = GLib.path_get_dirname(testFile);
    GLib.mkdir_with_parents(dir, 0o700);
    GLib.file_set_contents(testFile, 'NOT_VALID_JSON{{{');

    const store = new UsageHistoryStore(testFile);
    const settings = store.getSettings();
    assertEqual(settings.reloadMode, 'auto', 'reverted to default settings');

    // Should be able to save new valid data
    store.recordSample('gemini-5h', 0.8, '2026-10-22T00:00:00Z', 1700000000000);
    const store2 = new UsageHistoryStore(testFile);
    assertEqual(store2.analyzeBucket({ bucketId: 'gemini-5h' }).sampleCount, 1, 'saved cleanly over corrupt file');
});

test('UsageHistoryStore: validation errors and helper methods', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    assertThrows(() => store.recordSample('', 0.5, null), 'empty bucketId in recordSample');
    assertThrows(() => store.analyzeBucket({ bucketId: '' }), 'empty bucketId in analyzeBucket');

    store.recordSample('b1', 0.9, null, 1700000000000);
    store.recordSample('b2', 0.8, null, 1700000000000);
    assertEqual(store.getSamples('b1').length, 1, 'b1 has 1 sample');

    store.clearBucket('b1');
    assertEqual(store.getSamples('b1').length, 0, 'b1 was cleared');
    assertEqual(store.getSamples('b2').length, 1, 'b2 remains');

    store.clearAll();
    assertEqual(store.getSamples('b2').length, 0, 'all cleared');
});

test('analyzeBucket: derives missing remainingFraction and resetTime from last sample', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const resetTime = '2026-10-22T05:00:00Z';

    store.recordSample('gemini-weekly', 0.75, resetTime, 1700000000000);

    const analysis = store.analyzeBucket({
        bucketId: 'gemini-weekly',
        nowMs: 1700000000000,
    });

    assertAlmostEqual(analysis.remainingFraction, 0.75, 1e-4, 'derived remainingFraction');
    assertEqual(analysis.resetTimeIso, resetTime, 'derived resetTimeIso');
});

// -------------------------------------------------------------------------
// QA Edge-Case & Robustness Tests (Issue #1 Acceptance Criteria)
// -------------------------------------------------------------------------
test('QA Edge Case: recordSample clamps remainingFraction < 0 to 0.0 and > 1 to 1.0', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    store.recordSample('b-negative', -0.5, null, 1700000000000);
    store.recordSample('b-overflow', 1.5, null, 1700000000000);

    assertEqual(store.getSamples('b-negative')[0].r, 0, 'negative fraction must clamp to 0.0');
    assertEqual(store.getSamples('b-overflow')[0].r, 1, 'fraction > 1 must clamp to 1.0');
});

test('QA Edge Case: recordSample clamps Infinity to 1.0 and -Infinity to 0.0', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    store.recordSample('b-pos-inf', Infinity, null, 1700000000000);
    store.recordSample('b-neg-inf', -Infinity, null, 1700000000000);

    assertEqual(store.getSamples('b-pos-inf')[0].r, 1, '+Infinity must clamp to 1.0');
    assertEqual(store.getSamples('b-neg-inf')[0].r, 0, '-Infinity must clamp to 0.0');
});

test('QA Edge Case: analyzeBucket clamps out-of-bounds and Infinity remainingFraction', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    const aNeg = store.analyzeBucket({ bucketId: 'b-neg', remainingFraction: -0.5 });
    assertEqual(aNeg.remainingFraction, 0, 'remainingFraction clamped to 0');
    assertEqual(aNeg.usedFraction, 1, 'usedFraction clamped to 1');
    assertEqual(aNeg.remainingPercent, 0, 'remainingPercent clamped to 0');
    assertEqual(aNeg.usedPercent, 100, 'usedPercent clamped to 100');

    const aHigh = store.analyzeBucket({ bucketId: 'b-high', remainingFraction: 1.5 });
    assertEqual(aHigh.remainingFraction, 1, 'remainingFraction clamped to 1');
    assertEqual(aHigh.usedFraction, 0, 'usedFraction clamped to 0');
    assertEqual(aHigh.remainingPercent, 100, 'remainingPercent clamped to 100');
    assertEqual(aHigh.usedPercent, 0, 'usedPercent clamped to 0');

    const aInf = store.analyzeBucket({ bucketId: 'b-inf', remainingFraction: Infinity });
    assertEqual(aInf.remainingFraction, 1, 'remainingFraction Infinity clamped to 1');

    const aNegInf = store.analyzeBucket({ bucketId: 'b-ninf', remainingFraction: -Infinity });
    assertEqual(aNegInf.remainingFraction, 0, 'remainingFraction -Infinity clamped to 0');
});

test('QA Edge Case: analyzeBucket handles invalid ISO date strings without throwing or NaN', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    const aInvalid = store.analyzeBucket({
        bucketId: 'b-invalid-date',
        remainingFraction: 0.5,
        resetTimeIso: 'THIS_IS_NOT_AN_ISO_DATE',
        nowMs: 1700000000000,
    });

    assertEqual(aInvalid.resetInMs, 0, 'invalid resetTimeIso should result in resetInMs = 0');
    assertEqual(aInvalid.resetInFormatted, 'Agora', 'resetInFormatted should be Agora');
    assertTrue(Number.isFinite(aInvalid.burnPercentPerHour), 'burnPercentPerHour must be a finite number');
});

test('QA Edge Case: analyzeBucket handles null resetTimeIso gracefully', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    const aNullDate = store.analyzeBucket({
        bucketId: 'b-null-date',
        remainingFraction: 0.8,
        resetTimeIso: null,
        nowMs: 1700000000000,
    });

    assertEqual(aNullDate.resetInMs, 0, 'null resetTimeIso should result in resetInMs = 0');
    assertEqual(aNullDate.resetInFormatted, 'Agora', 'resetInFormatted should be Agora');
    assertEqual(aNullDate.willExhaustBeforeReset, false, 'willExhaustBeforeReset should be false');
});

test('QA Edge Case: UsageHistoryStore safely recovers from 0-byte (empty) file', () => {
    const testFile = getTempTestFile();
    const dir = GLib.path_get_dirname(testFile);
    GLib.mkdir_with_parents(dir, 0o700);
    GLib.file_set_contents(testFile, '');

    const store = new UsageHistoryStore(testFile);
    const settings = store.getSettings();
    assertEqual(settings.reloadMode, 'auto', 'empty file falls back to default reloadMode');
    assertEqual(settings.autoActiveSec, 180, 'empty file falls back to default autoActiveSec');

    // Should be able to record and save without errors
    store.recordSample('b1', 0.9, null, 1700000000000);
    const storeReloaded = new UsageHistoryStore(testFile);
    assertEqual(storeReloaded.getSamples('b1').length, 1, 'saved cleanly over empty file');
});

test('QA Edge Case: UsageHistoryStore safely handles file containing null or []', () => {
    const testNull = getTempTestFile();
    GLib.mkdir_with_parents(GLib.path_get_dirname(testNull), 0o700);
    GLib.file_set_contents(testNull, 'null');
    const storeNull = new UsageHistoryStore(testNull);
    assertEqual(storeNull.getSettings().reloadMode, 'auto', 'null file returns default settings');

    const testArray = getTempTestFile();
    GLib.mkdir_with_parents(GLib.path_get_dirname(testArray), 0o700);
    GLib.file_set_contents(testArray, '[]');
    const storeArray = new UsageHistoryStore(testArray);
    assertEqual(storeArray.getSettings().reloadMode, 'auto', 'array file returns default settings');
});

test('QA Edge Case: deduplication exact boundary at 10 minutes (599,999 ms vs 600,000 ms)', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    const resetTime = '2026-10-22T00:00:00Z';

    // Base sample
    store.recordSample('b-dedup-bound', 0.5000, resetTime, t0);

    // Exact boundary 1: 9 minutes 59.999 seconds (599,999 ms, < 10m) -> deduplicated (false)
    const resDedup = store.recordSample('b-dedup-bound', 0.5000, resetTime, t0 + 599999);
    assertEqual(resDedup, false, 'sample at 599,999 ms should be deduplicated');
    assertEqual(store.getSamples('b-dedup-bound').length, 1, 'sample count remains 1');

    // Exact boundary 2: exact 10 minutes (600,000 ms, >= 10m) -> recorded (true)
    const resRecorded = store.recordSample('b-dedup-bound', 0.5000, resetTime, t0 + 600000);
    assertEqual(resRecorded, true, 'sample at 600,000 ms must be recorded');
    assertEqual(store.getSamples('b-dedup-bound').length, 2, 'sample count becomes 2');
});

test('QA Edge Case: cycle reset exact boundary at 2% jump (+1.9% vs +2.5%)', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;
    const resetTime = '2026-10-22T00:00:00Z';

    store.recordSample('b-reset-bound', 0.500, resetTime, t0);

    // +1.9% jump (0.500 -> 0.519, delta = 0.019 <= 0.02) -> must NOT trigger reset
    store.recordSample('b-reset-bound', 0.519, resetTime, t0 + 600000);
    assertEqual(store.getSamples('b-reset-bound').length, 2, '+1.9% jump must not clear previous cycle');

    // +2.5% jump from 0.519 to 0.544 (delta = 0.025 > 0.02) -> must trigger reset and clear previous cycle
    store.recordSample('b-reset-bound', 0.544, resetTime, t0 + 1200000);
    assertEqual(store.getSamples('b-reset-bound').length, 1, '+2.5% jump must trigger reset and clear bucket');
    assertAlmostEqual(store.getSamples('b-reset-bound')[0].r, 0.544, 1e-4, 'only new cycle sample remains');
});

test('QA Edge Case: retention exact boundary at 8 days (8 days kept vs 8 days + 1ms pruned)', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const eightDaysMs = 8 * 24 * 3600 * 1000;
    const now = 2000000000000;

    // Sample 1: Exactly 8 days ago (now - eightDaysMs) -> must be KEPT
    store.recordSample('b-retention-kept', 0.9, null, now - eightDaysMs);
    store.recordSample('b-retention-kept', 0.8, null, now);
    assertEqual(store.getSamples('b-retention-kept').length, 2, 'sample at exact 8 days boundary must be kept');

    // Sample 2: 8 days and 1 millisecond ago (now - eightDaysMs - 1) -> must be PRUNED
    store.recordSample('b-retention-pruned', 0.9, null, now - eightDaysMs - 1);
    store.recordSample('b-retention-pruned', 0.8, null, now);
    assertEqual(store.getSamples('b-retention-pruned').length, 1, 'sample older than 8 days by 1ms must be pruned');
});

test('QA Edge Case: sample cap exact boundary at 500 samples (505 samples capped at 500)', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const t0 = 1700000000000;

    for (let i = 0; i < 505; i++) {
        store.recordSample('b-cap', (i % 100) / 100, null, t0 + (i + 1) * 600000);
    }

    assertEqual(store.getSamples('b-cap').length, 500, 'bucket must be capped at exactly 500 samples');
});

test('QA Bug Detection: recordSample handles NaN without corrupting bucket samples to null or NaN', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    let threw = false;
    let recorded = false;
    try {
        recorded = store.recordSample('b-nan', NaN, null, 1700000000000);
    } catch (e) {
        threw = true;
    }

    if (!threw && recorded) {
        const storeReloaded = new UsageHistoryStore(testFile);
        const samples = storeReloaded.getSamples('b-nan');
        assertTrue(
            samples.length > 0 && typeof samples[0].r === 'number' && Number.isFinite(samples[0].r),
            'Sample r on disk must be a finite number according to SCHEMA.md, but got ' + JSON.stringify(samples[0]?.r)
        );
    }
});

test('QA Bug Detection: analyzeBucket handles NaN remainingFraction gracefully without returning NaN percentages', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    let threw = false;
    let analysis;
    try {
        analysis = store.analyzeBucket({
            bucketId: 'b-nan-analysis',
            remainingFraction: NaN,
            nowMs: 1700000000000,
        });
    } catch (e) {
        threw = true;
    }

    if (!threw && analysis) {
        assertTrue(
            Number.isFinite(analysis.remainingFraction) &&
            Number.isFinite(analysis.remainingPercent) &&
            Number.isFinite(analysis.usedPercent),
            'Analysis fractions and percentages must be finite numbers, got ' +
            JSON.stringify({
                remainingFraction: analysis.remainingFraction,
                remainingPercent: analysis.remainingPercent,
                usedPercent: analysis.usedPercent,
            })
        );
    }
});

test('QA Bug Detection: recordSample does not falsely trigger cycle reset when previous sample r is null or invalid', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    const resetTime = '2026-10-22T00:00:00Z';
    const t0 = 1700000000000;

    // Legitimate historical sample
    store.recordSample('b-false-reset', 0.80, resetTime, t0);

    // Corrupted sample with NaN/null
    store.recordSample('b-false-reset', NaN, resetTime, t0 + 600000);

    // Next legitimate sample with normal consumption (0.75 <= 0.80)
    const storeReloaded = new UsageHistoryStore(testFile);
    storeReloaded.recordSample('b-false-reset', 0.75, resetTime, t0 + 1200000);

    const samples = storeReloaded.getSamples('b-false-reset');
    assertTrue(
        samples.length >= 2,
        'Previous samples must not be wiped out by false cycle reset from null last.r (got count ' + samples.length + ')'
    );
});

// -------------------------------------------------------------------------
// Security Audit Tests (SEC-01 to SEC-04)
// -------------------------------------------------------------------------
test('SEC-01: Prototype pollution prevention and strict bucketId validation', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    // 1. Prototype of buckets must be null
    assertTrue(Object.getPrototypeOf(store._data.buckets) === null, 'buckets object must have null prototype');

    // 2. Reserved prototype keys must throw
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']) {
        assertThrows(() => store.recordSample(key, 0.5, null, 1700000000000), `recordSample with forbidden key ${key}`);
        assertThrows(() => store.analyzeBucket({ bucketId: key }), `analyzeBucket with forbidden key ${key}`);
    }

    // 3. Path traversal or injection in bucketId must throw
    for (const invalidId of ['../../etc/passwd', 'bucket with spaces', 'id/with/slash', '', 'a'.repeat(65), 'invalid$char!']) {
        assertThrows(() => store.recordSample(invalidId, 0.5, null, 1700000000000), `recordSample with invalid bucketId: ${invalidId}`);
        assertThrows(() => store.analyzeBucket({ bucketId: invalidId }), `analyzeBucket with invalid bucketId: ${invalidId}`);
    }

    // 4. Valid bucket IDs must be accepted
    assertTrue(store.recordSample('valid-bucket_1.0', 0.9, null, 1700000000000), 'valid alphanumeric and ._- bucketId');
});

test('SEC-02: Enforces 0o700 permissions on directory and 0o600 on history.json', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);
    store.recordSample('sec-perm', 0.8, null, 1700000000000);

    const parentDir = GLib.path_get_dirname(testFile);
    const dirFile = Gio.File.new_for_path(parentDir);
    const dirInfo = dirFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    const dirMode = dirInfo.get_attribute_uint32('unix::mode') & 0o777;
    assertEqual(dirMode, 0o700, 'parent directory permissions must be 0700');

    const histFile = Gio.File.new_for_path(testFile);
    const histInfo = histFile.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null);
    const histMode = histInfo.get_attribute_uint32('unix::mode') & 0o777;
    assertEqual(histMode, 0o600, 'history.json file permissions must be 0600');
});

test('SEC-03: Settings sanitization ignores __proto__ pollution and invalid fields', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    // Update with prototype poisoning attempt and unrecognized fields
    store.updateSettings(JSON.parse('{"__proto__":{"polluted":true},"evilField":"hacked","reloadMode":900,"autoActiveSec":60}'));

    const settings = store.getSettings();
    assertEqual(settings.reloadMode, 900, 'valid reloadMode updated');
    assertEqual(settings.autoActiveSec, 60, 'valid autoActiveSec updated');
    assertEqual(settings.evilField, undefined, 'unknown fields discarded');
    assertEqual(Object.prototype.polluted, undefined, 'Object.prototype must not be polluted');

    // Test direct sanitizeSettings function
    const sanitized = sanitizeSettings({
        reloadMode: 'invalid_mode',
        autoActiveSec: 999999, // out of range
        autoIdleSec: 3600,
        showPanelPercent: false,
        extra: 42,
    });
    assertEqual(sanitized.reloadMode, 'auto', 'invalid reloadMode preserved default');
    assertEqual(sanitized.autoActiveSec, 180, 'out-of-range autoActiveSec preserved default');
    assertEqual(sanitized.autoIdleSec, 3600, 'valid autoIdleSec applied');
    assertEqual(sanitized.showPanelPercent, false, 'valid showPanelPercent applied');
    assertEqual(sanitized.extra, undefined, 'extra property stripped');
});

test('SEC-04: Timestamp validation and bucket capacity limit (MAX_BUCKETS = 50)', () => {
    const testFile = getTempTestFile();
    const store = new UsageHistoryStore(testFile);

    // 1. Invalid nowMs must throw
    assertThrows(() => store.recordSample('b-sec', 0.5, null, -100), 'negative nowMs must throw');
    assertThrows(() => store.recordSample('b-sec', 0.5, null, 0), 'zero nowMs must throw');
    assertThrows(() => store.recordSample('b-sec', 0.5, null, NaN), 'NaN nowMs must throw');
    assertThrows(() => store.recordSample('b-sec', 0.5, null, Infinity), 'Infinity nowMs must throw');
    assertThrows(() => store.recordSample('b-sec', 0.5, null, 'not_a_number'), 'string nowMs must throw');

    // 2. Capacity limit: adding 52 buckets must cap at 50, evicting the oldest
    const baseTime = 1700000000000;
    for (let i = 0; i < 52; i++) {
        // bucket-0 is the oldest (timestamp baseTime + 0), bucket-51 is newest
        store.recordSample(`bucket-${i}`, 0.9, null, baseTime + (i * 1000));
    }

    assertEqual(Object.keys(store._data.buckets).length, MAX_BUCKETS, `bucket count must be capped at ${MAX_BUCKETS}`);
    // bucket-0 and bucket-1 should have been evicted
    assertEqual(store.getSamples('bucket-0').length, 0, 'bucket-0 (oldest) was evicted');
    assertEqual(store.getSamples('bucket-1').length, 0, 'bucket-1 was evicted');
    assertTrue(store.getSamples('bucket-51').length > 0, 'bucket-51 (newest) is present');
});



