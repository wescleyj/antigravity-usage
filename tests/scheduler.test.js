import GLib from 'gi://GLib';
import {
    test,
    assertEqual,
    assertTrue,
    assertThrows,
} from './assert.js';
import {
    RELOAD_OPTIONS,
    computeEffectiveIntervalSec,
    VirtualTimerBackend,
    GLibTimerBackend,
    ReloadScheduler,
} from '../src/lib/scheduler.js';
import { UsageHistoryStore } from '../src/lib/history.js';

function getTempTestFile() {
    const tmpDir = GLib.build_filenamev([GLib.get_tmp_dir(), 'sched-test-' + Math.random().toString(36).substring(2)]);
    return GLib.build_filenamev([tmpDir, 'history.json']);
}

// -------------------------------------------------------------------------
// RELOAD_OPTIONS tests
// -------------------------------------------------------------------------
test('RELOAD_OPTIONS: structure and immutability', () => {
    assertTrue(Array.isArray(RELOAD_OPTIONS), 'RELOAD_OPTIONS is an array');
    assertTrue(Object.isFrozen(RELOAD_OPTIONS), 'RELOAD_OPTIONS must be frozen');

    const ids = RELOAD_OPTIONS.map(opt => opt.id);
    assertEqual(ids, ['auto', 60, 300, 900, 1800, 3600], 'expected reload option IDs');

    const autoOpt = RELOAD_OPTIONS.find(opt => opt.id === 'auto');
    assertTrue(autoOpt.label.includes('Auto'), 'auto option label mentions Auto');
});

// -------------------------------------------------------------------------
// computeEffectiveIntervalSec tests
// -------------------------------------------------------------------------
test('computeEffectiveIntervalSec: auto mode adaptive calculation', () => {
    // Default auto settings: active 180s, idle 1800s
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 'auto' }, true), 180, 'active CLI -> 180s');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 'auto' }, false), 1800, 'idle CLI -> 1800s');

    // Default settings when undefined or null
    assertEqual(computeEffectiveIntervalSec(null, true), 180, 'null settings -> default active');
    assertEqual(computeEffectiveIntervalSec(null, false), 1800, 'null settings -> default idle');

    // Custom auto active/idle
    assertEqual(
        computeEffectiveIntervalSec({ reloadMode: 'auto', autoActiveSec: 120, autoIdleSec: 3600 }, true),
        120,
        'custom active interval'
    );
    assertEqual(
        computeEffectiveIntervalSec({ reloadMode: 'auto', autoActiveSec: 120, autoIdleSec: 3600 }, false),
        3600,
        'custom idle interval'
    );

    // Clamping limits (active 60..3600, idle 300..7200)
    assertEqual(
        computeEffectiveIntervalSec({ reloadMode: 'auto', autoActiveSec: 10, autoIdleSec: 100 }, true),
        60,
        'clamped minimum active interval'
    );
    assertEqual(
        computeEffectiveIntervalSec({ reloadMode: 'auto', autoActiveSec: 5000, autoIdleSec: 9999 }, false),
        7200,
        'clamped maximum idle interval'
    );
});

test('computeEffectiveIntervalSec: manual mode intervals', () => {
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 60 }, false), 60, '1 min manual');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 300 }, true), 300, '5 min manual (ignores CLI state)');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 900 }, false), 900, '15 min manual');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 1800 }, true), 1800, '30 min manual');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 3600 }, false), 3600, '1 hour manual');

    // Non-standard numeric values clamped safely
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 10 }, false), 60, 'manual < 60 clamped to 60');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 5000 }, false), 3600, 'manual > 3600 clamped to 3600');
});

// -------------------------------------------------------------------------
// VirtualTimerBackend tests
// -------------------------------------------------------------------------
test('VirtualTimerBackend: advances time and executes scheduled callbacks', () => {
    const backend = new VirtualTimerBackend();
    let calls = 0;

    const id = backend.timeoutAddSeconds(0, 10, () => {
        calls++;
        return true; // repeat
    });

    assertEqual(calls, 0, 'no calls before advancing time');

    backend.advanceTime(5);
    assertEqual(calls, 0, 'still no calls at t=5');

    backend.advanceTime(5);
    assertEqual(calls, 1, 'called at t=10');

    backend.advanceTime(10);
    assertEqual(calls, 2, 'called again at t=20');

    backend.sourceRemove(id);
    backend.advanceTime(20);
    assertEqual(calls, 2, 'no more calls after sourceRemove');
});

// -------------------------------------------------------------------------
// ReloadScheduler tests
// -------------------------------------------------------------------------
test('ReloadScheduler: manual mode interval scheduling and execution', () => {
    const timerBackend = new VirtualTimerBackend();
    let reloadCount = 0;

    const scheduler = new ReloadScheduler({
        onReload: () => { reloadCount++; },
        timerBackend,
    });

    scheduler.setReloadMode(300); // 5 minutes
    scheduler.start();

    assertEqual(scheduler.getCurrentIntervalSec(), 300, 'current interval is 300s');
    assertEqual(reloadCount, 0, 'not reloaded yet');

    timerBackend.advanceTime(299);
    assertEqual(reloadCount, 0, 'at 299s still not reloaded');

    timerBackend.advanceTime(1);
    assertEqual(reloadCount, 1, 'reloaded at 300s');

    timerBackend.advanceTime(300);
    assertEqual(reloadCount, 2, 'reloaded again at 600s');

    scheduler.destroy();
});

test('ReloadScheduler: adaptive auto mode switches intervals based on process state', () => {
    const timerBackend = new VirtualTimerBackend();
    let reloadCount = 0;
    let cliRunning = false;

    const scheduler = new ReloadScheduler({
        onRefresh: () => { reloadCount++; },
        processChecker: () => cliRunning,
        timerBackend,
        watcherIntervalSec: 60,
    });

    scheduler.setReloadMode('auto');
    scheduler.start();

    // Initial state: CLI closed -> 1800s interval
    assertEqual(scheduler.isAgyRunning(), false, 'initial isAgyRunning is false');
    assertEqual(scheduler.getCurrentIntervalSec(), 1800, 'initial interval is 1800s');
    assertEqual(reloadCount, 0, 'no reload yet');

    // 1. Advance 60s: watcher runs, CLI still false
    timerBackend.advanceTime(60);
    assertEqual(reloadCount, 0, 'CLI still closed, no reload');

    // 2. CLI is opened! Next watcher check at 120s detects transition
    cliRunning = true;
    timerBackend.advanceTime(60);

    // Watcher detected closed -> open transition: must trigger immediate reload!
    assertEqual(reloadCount, 1, 'transition to open must trigger immediate reload');
    assertEqual(scheduler.isAgyRunning(), true, 'isAgyRunning updated to true');
    assertEqual(scheduler.getCurrentIntervalSec(), 180, 'interval switched to active 180s');

    // 3. While open, reload runs every 180s
    timerBackend.advanceTime(180);
    assertEqual(reloadCount, 2, 'active reload triggered at +180s');

    // 4. CLI closed: watcher detects open -> closed transition
    cliRunning = false;
    timerBackend.advanceTime(60); // watcher tick

    assertEqual(scheduler.isAgyRunning(), false, 'isAgyRunning updated to false');
    assertEqual(scheduler.getCurrentIntervalSec(), 1800, 'interval switched to idle 1800s');
    // Note: open -> closed transition does NOT trigger an immediate reload, just adjusts next interval
    assertEqual(reloadCount, 2, 'no extra reload on close');

    scheduler.destroy();
});

test('ReloadScheduler: forceRefresh cancels pending timer, prevents concurrency, and reschedules', async () => {
    const timerBackend = new VirtualTimerBackend();
    let reloadCount = 0;

    let resolveSlowTask = null;
    const scheduler = new ReloadScheduler({
        onReload: () => {
            reloadCount++;
            if (resolveSlowTask) {
                return new Promise(res => {
                    const prev = resolveSlowTask;
                    resolveSlowTask = null;
                    prev(res);
                });
            }
        },
        timerBackend,
    });

    scheduler.setReloadMode(300);
    scheduler.start();

    // 1. Initial forceRefresh
    await scheduler.forceRefresh();
    assertEqual(reloadCount, 1, 'forceRefresh executed reload');

    // 2. Concurrency test: trigger second reload which stays pending until released
    let release;
    resolveSlowTask = (done) => { release = done; };

    const p1 = scheduler.forceRefresh();
    // Immediate concurrent call should be dropped while reloading is in progress
    const p2 = scheduler.forceRefresh();

    assertEqual(scheduler.getState().isReloading, true, 'isReloading is true during execution');

    // Release the pending task
    release();
    await Promise.all([p1, p2]);

    assertEqual(reloadCount, 2, 'concurrency prevented duplicate simultaneous reload');
    assertEqual(scheduler.getState().isReloading, false, 'isReloading is false after completion');

    scheduler.destroy();
});

test('ReloadScheduler: integrates with UsageHistoryStore for settings persistence', () => {
    const testFile = getTempTestFile();
    const historyStore = new UsageHistoryStore(testFile);
    const timerBackend = new VirtualTimerBackend();

    const scheduler = new ReloadScheduler({
        onReload: () => {},
        historyStore,
        timerBackend,
    });

    assertEqual(scheduler.getReloadMode(), 'auto', 'default mode from store');

    scheduler.setReloadMode(900);
    assertEqual(scheduler.getReloadMode(), 900, 'mode updated');
    assertEqual(historyStore.getSettings().reloadMode, 900, 'store settings updated and persisted');

    // Verify persistence across new store instance
    const historyStore2 = new UsageHistoryStore(testFile);
    assertEqual(historyStore2.getSettings().reloadMode, 900, 'persisted mode reloaded in store');

    scheduler.destroy();
});

test('ReloadScheduler: destroy cleans up all active timers completely', () => {
    const timerBackend = new VirtualTimerBackend();
    let reloaded = false;

    const scheduler = new ReloadScheduler({
        onReload: () => { reloaded = true; },
        processChecker: () => true,
        timerBackend,
    });

    scheduler.start();
    scheduler.destroy();

    const state = scheduler.getState();
    assertEqual(state.isRunning, false, 'scheduler marked not running');

    // Advance time significantly
    timerBackend.advanceTime(10000);
    assertEqual(reloaded, false, 'no callbacks fired after destroy');
});

// -------------------------------------------------------------------------
// QA Edge-Case & Robustness Tests (Issue #3 Acceptance Criteria)
// -------------------------------------------------------------------------
test('QA Edge Case: onReload throwing synchronous exception clears isReloading and reschedules next timer', () => {
    const timerBackend = new VirtualTimerBackend();
    let calls = 0;

    const scheduler = new ReloadScheduler({
        onReload: () => {
            calls++;
            throw new Error('Simulated synchronous reload failure');
        },
        timerBackend,
    });

    scheduler.setReloadMode(60);
    scheduler.start();

    // Trigger initial reload which throws
    scheduler.forceRefresh();
    assertEqual(calls, 1, 'callback was called once');
    assertEqual(scheduler.getState().isReloading, false, 'isReloading is cleared in finally block');

    // Advance by interval (60s) - scheduler must have rescheduled despite the exception
    timerBackend.advanceTime(60);
    assertEqual(calls, 2, 'next cycle was rescheduled and executed despite previous exception');
    assertEqual(scheduler.getState().isReloading, false, 'isReloading remains false after second run');

    scheduler.destroy();
});

test('QA Edge Case: onReload returning rejected promise clears isReloading and reschedules next timer', async () => {
    const timerBackend = new VirtualTimerBackend();
    let calls = 0;

    const scheduler = new ReloadScheduler({
        onReload: () => {
            calls++;
            return Promise.reject(new Error('Simulated async network error'));
        },
        timerBackend,
    });

    scheduler.setReloadMode(60);
    scheduler.start();

    // Trigger async reload which rejects
    await scheduler.forceRefresh();
    assertEqual(calls, 1, 'async callback called');
    assertEqual(scheduler.getState().isReloading, false, 'isReloading cleared after async rejection');

    // Advance by 60s
    timerBackend.advanceTime(60);
    assertEqual(calls, 2, 'next cycle executed after async rejection');

    scheduler.destroy();
});

test('QA Edge Case: destroy() called while async forceRefresh is in-flight prevents rescheduling timers', async () => {
    const timerBackend = new VirtualTimerBackend();
    let releaseTask;
    let calls = 0;

    const scheduler = new ReloadScheduler({
        onReload: () => {
            calls++;
            return new Promise(res => { releaseTask = res; });
        },
        timerBackend,
    });

    scheduler.setReloadMode(60);
    scheduler.start();

    // Start in-flight refresh
    const refreshPromise = scheduler.forceRefresh();
    assertEqual(scheduler.getState().isReloading, true, 'task in-flight');

    // Destroy scheduler while task is still running
    scheduler.destroy();
    assertEqual(scheduler.getState().isRunning, false, 'scheduler is stopped');

    // Complete the in-flight task
    releaseTask();
    await refreshPromise;

    assertEqual(scheduler.getState().isReloading, false, 'isReloading finalized');

    // Advance time significantly - no new timer must have been scheduled after destroy
    timerBackend.advanceTime(10000);
    assertEqual(calls, 1, 'no further reload calls after destroy even if in-flight task completed later');
});

test('QA Edge Case: multiple sequential calls to start() without stop() do not create duplicate timers', () => {
    const timerBackend = new VirtualTimerBackend();
    let calls = 0;

    const scheduler = new ReloadScheduler({
        onReload: () => { calls++; },
        timerBackend,
    });

    scheduler.setReloadMode(60);

    // Call start multiple times in a row
    scheduler.start();
    scheduler.start();
    scheduler.start();
    scheduler.start();

    assertEqual(calls, 0, 'no calls before timer elapses');

    // Advance 60s
    timerBackend.advanceTime(60);
    assertEqual(calls, 1, 'exactly one callback fired (no duplicate timers created)');

    // Advance another 60s
    timerBackend.advanceTime(60);
    assertEqual(calls, 2, 'exactly two callbacks fired at 120s');

    scheduler.destroy();
});

test('QA Edge Case: computeEffectiveIntervalSec handles invalid, non-numeric, or null settings gracefully', () => {
    // Null and empty object
    assertEqual(computeEffectiveIntervalSec(null, false), 1800, 'null settings idle');
    assertEqual(computeEffectiveIntervalSec({}, true), 180, 'empty object active');

    // Non-numeric reloadMode strings
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 'invalid_mode' }, false), 180, 'invalid string fallback');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: NaN }, false), 180, 'NaN mode fallback');

    // Boundary edge numbers
    assertEqual(computeEffectiveIntervalSec({ reloadMode: -50 }, false), 60, 'negative manual clamped to 60');
    assertEqual(computeEffectiveIntervalSec({ reloadMode: 100000 }, false), 3600, 'huge manual clamped to 3600');
});

// -------------------------------------------------------------------------
// Security Audit Tests (SEC-SCHED-01 to SEC-SCHED-03)
// -------------------------------------------------------------------------
test('SEC-SCHED-01: watcherIntervalSec handles NaN, non-finite and boundary values safely', () => {
    const timerBackend = new VirtualTimerBackend();

    // 1. Non-finite or invalid types fallback to 60s
    for (const invalidSec of [NaN, Infinity, -Infinity, null, undefined, '60', {}, []]) {
        const sched = new ReloadScheduler({ watcherIntervalSec: invalidSec, timerBackend });
        assertEqual(sched._watcherIntervalSec, 60, `watcherIntervalSec with ${invalidSec} falls back to 60`);
    }

    // 2. Boundary clamping: min 10s, max 300s
    const schedLow = new ReloadScheduler({ watcherIntervalSec: 2, timerBackend });
    assertEqual(schedLow._watcherIntervalSec, 10, 'watcherIntervalSec clamped to minimum 10s');

    const schedHigh = new ReloadScheduler({ watcherIntervalSec: 500, timerBackend });
    assertEqual(schedHigh._watcherIntervalSec, 300, 'watcherIntervalSec clamped to maximum 300s');
});

test('SEC-SCHED-02: Deep freeze enforcement on RELOAD_OPTIONS and all entries', () => {
    assertTrue(Object.isFrozen(RELOAD_OPTIONS), 'outer array must be frozen');

    for (const opt of RELOAD_OPTIONS) {
        assertTrue(Object.isFrozen(opt), `inner option object for ${opt.id} must be frozen`);
        try {
            opt.label = 'TAMPERED';
        } catch (e) {
            // TypeError in strict mode is expected
        }
        assertTrue(opt.label !== 'TAMPERED', 'option label cannot be tampered');
    }
});

test('SEC-SCHED-03: Post-destroy() guard prevents start(), forceRefresh(), and timer creation', async () => {
    const timerBackend = new VirtualTimerBackend();
    let reloadCalls = 0;

    const scheduler = new ReloadScheduler({
        onReload: () => { reloadCalls++; },
        timerBackend,
    });

    scheduler.start();
    scheduler.destroy();

    const state = scheduler.getState();
    assertEqual(state.isDestroyed, true, 'isDestroyed flag must be true');
    assertEqual(state.isRunning, false, 'isRunning flag must be false');

    // 1. start() after destroy() must be a no-op
    scheduler.start();
    assertEqual(scheduler.getState().isRunning, false, 'start() after destroy() is ignored');

    // 2. forceRefresh() after destroy() must be a no-op
    await scheduler.forceRefresh();
    assertEqual(reloadCalls, 0, 'forceRefresh() after destroy() is ignored');

    // 3. setReloadMode() after destroy() must be a no-op
    scheduler.setReloadMode(60);
    assertEqual(scheduler.getReloadMode(), 'auto', 'setReloadMode() after destroy() is ignored');

    // 4. Advancing time creates zero calls
    timerBackend.advanceTime(10000);
    assertEqual(reloadCalls, 0, 'no timers execute after destroy()');
});


