import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    test,
    assertEqual,
    assertAlmostEqual,
    assertTrue,
    assertThrows,
} from './assert.js';
import {
    getQuotaHealth,
    formatTopBarText,
    formatClockTime,
    formatHeaderState,
    formatBucketCard,
    formatModelFamiliesList,
    formatReloadMenuOptions,
    truncateString,
} from '../src/lib/viewModel.js';
import ExtensionClass from '../src/extension.js';

// Helper to read workspace file contents as UTF-8 string
function readProjectFile(relPath) {
    const fullPath = GLib.build_filenamev([GLib.get_current_dir(), relPath]);
    const file = Gio.File.new_for_path(fullPath);
    const [ok, bytes] = file.load_contents(null);
    if (!ok) {
        throw new Error(`Failed to load file: ${fullPath}`);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

// -------------------------------------------------------------------------
// viewModel.js: getQuotaHealth tests
// -------------------------------------------------------------------------
test('getQuotaHealth: maps fractions correctly to good, warn, and crit levels', () => {
    // > 0.50 -> good
    const good1 = getQuotaHealth(1.0);
    assertEqual(good1.level, 'good', '1.0 is good');
    assertEqual(good1.colorClass, 'quota-good', 'class is quota-good');

    const good2 = getQuotaHealth(0.51);
    assertEqual(good2.level, 'good', '0.51 is good');

    // <= 0.50 and > 0.20 -> warn
    const warn1 = getQuotaHealth(0.50);
    assertEqual(warn1.level, 'warn', '0.50 is warn');
    assertEqual(warn1.colorClass, 'quota-warn', 'class is quota-warn');

    const warn2 = getQuotaHealth(0.21);
    assertEqual(warn2.level, 'warn', '0.21 is warn');

    // <= 0.20 -> crit
    const crit1 = getQuotaHealth(0.20);
    assertEqual(crit1.level, 'crit', '0.20 is crit');
    assertEqual(crit1.colorClass, 'quota-crit', 'class is quota-crit');

    const crit2 = getQuotaHealth(0.0);
    assertEqual(crit2.level, 'crit', '0.0 is crit');

    // Edge cases and clamps
    const negative = getQuotaHealth(-0.5);
    assertEqual(negative.level, 'crit', 'negative clamped to 0 / crit');

    const excessive = getQuotaHealth(1.5);
    assertEqual(excessive.level, 'good', '> 1 clamped to 1 / good');

    const nanVal = getQuotaHealth(NaN);
    assertEqual(nanVal.level, 'good', 'NaN defaults to good/safe');

    const nullVal = getQuotaHealth(null);
    assertEqual(nullVal.level, 'good', 'null defaults to good/safe');
});

// -------------------------------------------------------------------------
// viewModel.js: formatTopBarText tests
// -------------------------------------------------------------------------
test('formatTopBarText: formats Top Bar text and handles empty/loading/error states', () => {
    // Normal snapshot
    const snap = {
        lowestRemainingPercent: 74.2,
        activeFamily: { displayName: 'Gemini 4 Argon' },
    };
    assertEqual(formatTopBarText(snap), '74%', 'basic percent formatting');

    // With model label option
    assertEqual(
        formatTopBarText(snap, { includeModel: true }),
        'Argon: 74%',
        'includes shortened model name'
    );

    // Truncation if model name is excessively long
    const longModelSnap = {
        lowestRemainingPercent: 50,
        activeFamily: { displayName: 'Very Long Model Name That Exceeds Maximum Reasonable Top Bar Limits' },
    };
    const longFormatted = formatTopBarText(longModelSnap, { includeModel: true });
    assertTrue(longFormatted.length <= 25, 'top bar text is length constrained');

    // Loading / null state
    assertEqual(formatTopBarText(null), '...', 'null snapshot returns ellipsis');
    assertEqual(formatTopBarText({ lowestRemainingPercent: null }), '...', 'missing percent returns ellipsis');

    // Error state
    assertEqual(formatTopBarText(null, { error: true }), 'Erro', 'error state returns Erro');
});

// -------------------------------------------------------------------------
// viewModel.js: formatClockTime tests
// -------------------------------------------------------------------------
test('formatClockTime: formats timestamps and handles invalid inputs', () => {
    // Valid timestamp (2026-10-20 15:42:00 local)
    const d = new Date(2026, 9, 20, 15, 42, 0);
    const formatted = formatClockTime(d.getTime());
    assertEqual(formatted, '15:42', 'formats HH:MM');

    // Single digit minutes/hours pad with 0
    const dPad = new Date(2026, 9, 20, 9, 5, 0);
    assertEqual(formatClockTime(dPad.getTime()), '09:05', 'pads single digits');

    // Invalid inputs return fallback
    assertEqual(formatClockTime(null), '--:--', 'null returns --:--');
    assertEqual(formatClockTime(0), '--:--', '0 returns --:--');
    assertEqual(formatClockTime(NaN), '--:--', 'NaN returns --:--');
    assertEqual(formatClockTime('invalid'), '--:--', 'string returns --:--');
});

// -------------------------------------------------------------------------
// viewModel.js: formatHeaderState tests
// -------------------------------------------------------------------------
test('formatHeaderState: aggregates header state, badges, and project info', () => {
    const snap = {
        projectId: 'my-gcp-ai-project-12345',
        activeModel: 'Gemini 4 Argon (Medium)',
        activeFamily: { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon' },
        timestamp: new Date(2026, 9, 20, 14, 30, 0).getTime(),
    };

    // When process is running
    const stateRunning = formatHeaderState(snap, true);
    assertEqual(stateRunning.projectId, 'my-gcp-ai-project-12345', 'preserves projectId');
    assertEqual(stateRunning.activeModel, 'Gemini 4 Argon (Medium)', 'preserves activeModel');
    assertEqual(stateRunning.activeFamilyName, 'Gemini 4 Argon', 'resolves activeFamilyName');
    assertEqual(stateRunning.processStatus.label, 'CLI Ativo', 'process status is CLI Ativo');
    assertEqual(stateRunning.processStatus.badgeClass, 'badge-active', 'badgeClass is badge-active');
    assertTrue(stateRunning.processStatus.isRunning, 'isRunning is true');
    assertEqual(stateRunning.lastUpdatedFormatted, '14:30', 'formats lastUpdated');

    // When process is closed
    const stateClosed = formatHeaderState(snap, false);
    assertEqual(stateClosed.processStatus.label, 'CLI Fechado', 'process status is CLI Fechado');
    assertEqual(stateClosed.processStatus.badgeClass, 'badge-inactive', 'badgeClass is badge-inactive');
    assertTrue(!stateClosed.processStatus.isRunning, 'isRunning is false');

    // Handles null / empty snapshot
    const stateEmpty = formatHeaderState(null, false);
    assertEqual(stateEmpty.projectId, 'default-cli-project', 'fallback projectId');
    assertEqual(stateEmpty.activeModel, 'Gemini 4 Argon (Medium)', 'fallback model');
    assertEqual(stateEmpty.lastUpdatedFormatted, '--:--', 'fallback clock time');

    // Long project ID truncation
    const longProjectSnap = {
        projectId: 'super-long-organization-project-identifier-that-would-overflow-the-popup-dialog-header',
    };
    const stateTrunc = formatHeaderState(longProjectSnap, true);
    assertTrue(stateTrunc.projectId.length <= 35, 'projectId truncated for header');
    assertTrue(stateTrunc.projectId.endsWith('...'), 'projectId has ellipsis');
});

// -------------------------------------------------------------------------
// viewModel.js: formatBucketCard tests
// -------------------------------------------------------------------------
test('formatBucketCard: formats weekly and 5h quota bucket cards', () => {
    const weeklyBucket = {
        bucketId: 'gemini-weekly',
        displayName: 'Weekly Limit Remaining',
        windowType: 'weekly',
        remainingFraction: 0.85,
        usedFraction: 0.15,
        remainingPercent: 85.0,
        usedPercent: 15.0,
        resetInFormatted: '1d 7h',
        burnPercentPerHour: 0.5,
        estimatedDurationFormatted: '3d 10h',
        estimatedLabel: 'Esgota em 3d 10h',
        willExhaustBeforeReset: true,
    };

    const card = formatBucketCard(weeklyBucket);
    assertEqual(card.bucketId, 'gemini-weekly', 'bucketId preserved');
    assertEqual(card.windowTitle, 'Semanal (7 dias)', 'canonical window title');
    assertEqual(card.remainingPercentFormatted, '85%', 'remaining percent formatted');
    assertEqual(card.usedPercentFormatted, '15%', 'used percent formatted');
    assertEqual(card.health.level, 'good', '85% is good health');
    assertEqual(card.resetText, 'Reinicia em 1d 7h', 'reset text with prefix');
    assertEqual(card.burnRateText, '0.5%/h', 'burn rate formatted');
    assertEqual(card.autonomyText, 'Esgota em 3d 10h', 'autonomy label mapped');
    assertTrue(card.willExhaustBeforeReset, 'willExhaustBeforeReset preserved');

    // 5h window
    const burstBucket = {
        bucketId: 'gemini-5h',
        windowType: '5h',
        remainingFraction: 0.20,
        resetInFormatted: '2h 15m',
        burnPercentPerHour: 0.0,
        estimatedDurationFormatted: null,
        willExhaustBeforeReset: false,
    };
    const burstCard = formatBucketCard(burstBucket);
    assertEqual(burstCard.windowTitle, 'Burst (5 horas)', 'burst window title');
    assertEqual(burstCard.health.level, 'crit', '20% is crit');
    assertEqual(burstCard.autonomyText, 'Seguro até o reset', 'safe autonomy fallback');

    // Null bucket fallback
    const nullCard = formatBucketCard(null, 'gemini-weekly');
    assertTrue(nullCard !== null, 'returns safe card object for null');
    assertEqual(nullCard.remainingPercentFormatted, '100%', 'default remaining 100%');
});

// -------------------------------------------------------------------------
// viewModel.js: formatModelFamiliesList tests
// -------------------------------------------------------------------------
test('formatModelFamiliesList: lists 5 canonical models with health and active badge', () => {
    const mockFamilies = [
        { id: 'gemini-4-argon', displayName: 'Gemini 4 Argon', group: 'gemini', remainingFraction: 0.85, remainingPercent: 85, isActive: true },
        { id: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', group: 'gemini', remainingFraction: 1.0, remainingPercent: 100, isActive: false },
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', group: '3p', remainingFraction: 0.37, remainingPercent: 37, isActive: false },
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', group: '3p', remainingFraction: 0.90, remainingPercent: 90, isActive: false },
        { id: 'gpt-oss-120b', displayName: 'GPT-OSS 120B', group: '3p', remainingFraction: 0.15, remainingPercent: 15, isActive: false },
    ];

    const list = formatModelFamiliesList(mockFamilies, 'Gemini 4 Argon (Medium)');
    assertEqual(list.length, 5, 'contains all 5 models');

    // Model 1: Argon (Active)
    assertEqual(list[0].displayName, 'Gemini 4 Argon', 'Argon display name');
    assertTrue(list[0].isActive, 'Argon is active');
    assertEqual(list[0].activeBadge, 'ATIVO', 'Argon has ATIVO badge');
    assertEqual(list[0].health.level, 'good', '85% is good');

    // Model 3: Claude Opus (Warn)
    assertEqual(list[2].displayName, 'Claude Opus 5.5', 'Opus display name');
    assertTrue(!list[2].isActive, 'Opus not active');
    assertEqual(list[2].activeBadge, null, 'no active badge');
    assertEqual(list[2].health.level, 'warn', '37% is warn');

    // Model 5: GPT-OSS (Crit)
    assertEqual(list[4].health.level, 'crit', '15% is crit');

    // Empty/null input fallback
    const fallbackList = formatModelFamiliesList(null, '');
    assertEqual(fallbackList.length, 5, 'returns 5 canonical models even when null');
});

// -------------------------------------------------------------------------
// viewModel.js: formatReloadMenuOptions tests
// -------------------------------------------------------------------------
test('formatReloadMenuOptions: formats Auto and manual interval options', () => {
    // Auto mode active (180s effective when running)
    const optionsAutoRunning = formatReloadMenuOptions(180, true);
    assertTrue(Array.isArray(optionsAutoRunning), 'returns array of options');
    assertTrue(optionsAutoRunning.length >= 6, 'has at least 6 interval choices');

    const autoOpt = optionsAutoRunning.find(o => o.id === 'auto');
    assertTrue(autoOpt !== undefined, 'has auto option');
    assertEqual(autoOpt.label, 'Automático', 'auto label');
    assertTrue(autoOpt.detail.includes('3m ativo'), 'mentions 3m active in detail');

    // Manual mode (300s = 5m selected)
    const options5m = formatReloadMenuOptions(300, false);
    const opt5m = options5m.find(o => o.seconds === 300);
    assertTrue(opt5m !== undefined, 'has 5m option');
    assertTrue(opt5m.isSelected, '5m is selected');
});

// -------------------------------------------------------------------------
// File Integrity: src/metadata.json
// -------------------------------------------------------------------------
test('metadata.json: matches GNOME Shell 45-52 extension manifest standards', () => {
    const raw = readProjectFile('src/metadata.json');
    const meta = JSON.parse(raw);

    assertEqual(meta.uuid, 'antigravity-usage@wescley.dev', 'UUID matches extension specification');
    assertEqual(meta.name, 'Antigravity Quota Usage', 'name matches');
    assertTrue(typeof meta.description === 'string' && meta.description.length > 10, 'description present');
    assertTrue(Array.isArray(meta['shell-version']), 'shell-version is array');

    // Shell version must span 45 to 52
    const versions = meta['shell-version'];
    for (const v of ['45', '46', '47', '48', '49', '50', '51', '52']) {
        assertTrue(versions.includes(v), `shell-version includes ${v}`);
    }
});

// -------------------------------------------------------------------------
// File Integrity: src/icons/antigravity-symbolic.svg
// -------------------------------------------------------------------------
test('antigravity-symbolic.svg: valid, safe, monochromatic vector icon', () => {
    const svg = readProjectFile('src/icons/antigravity-symbolic.svg');

    assertTrue(svg.includes('<svg'), 'is SVG root tag');
    assertTrue(svg.includes('</svg>'), 'has closing svg tag');
    assertTrue(svg.includes('viewBox') || (svg.includes('width') && svg.includes('height')), 'has dimensions');

    // Security check: zero scripts or event handlers in SVG
    assertTrue(!svg.toLowerCase().includes('<script'), 'no <script> tags allowed');
    assertTrue(!svg.toLowerCase().includes('onload'), 'no onload event handlers');
    assertTrue(!svg.toLowerCase().includes('onclick'), 'no onclick event handlers');
    assertTrue(!svg.toLowerCase().includes('javascript:'), 'no javascript: URIs');
    assertTrue(!svg.toLowerCase().includes('<foreignobject'), 'no foreignObject tags');
});

// -------------------------------------------------------------------------
// File Integrity: src/stylesheet.css
// -------------------------------------------------------------------------
test('stylesheet.css: contains all required style classes for Top Bar and Popup', () => {
    const css = readProjectFile('src/stylesheet.css');

    const requiredClasses = [
        'antigravity-panel-button',
        'antigravity-popup-header',
        'badge-active',
        'badge-inactive',
        'quota-card',
        'quota-progress-good',
        'quota-progress-warn',
        'quota-progress-crit',
        'model-family-item',
        'model-active-pill',
        'refresh-button',
    ];

    for (const cls of requiredClasses) {
        assertTrue(css.includes(cls), `CSS includes class .${cls}`);
    }
});

// -------------------------------------------------------------------------
// File Integrity & API Contract: src/extension.js
// -------------------------------------------------------------------------
test('extension.js: exports extension class with enable, disable, and destroy lifecycle', () => {
    assertTrue(typeof ExtensionClass === 'function', 'extension exports class/function');

    const ext = new ExtensionClass({
        uuid: 'antigravity-usage@wescley.dev',
        path: GLib.get_current_dir() + '/src',
    });

    assertTrue(typeof ext.enable === 'function', 'has enable() method');
    assertTrue(typeof ext.disable === 'function', 'has disable() method');
    assertTrue(typeof ext.destroy === 'function', 'has destroy() cleanup method');

    // Test calling disable/destroy without enable is safe (no null pointer exceptions)
    ext.disable();
    ext.destroy();
});

// -------------------------------------------------------------------------
// QA Edge Cases & Security Audits for UI Layer
// -------------------------------------------------------------------------
test('QA Edge Case: truncateString handles boundary lengths and non-string inputs', () => {
    assertEqual(truncateString(null), '', 'null returns empty string');
    assertEqual(truncateString(undefined), '', 'undefined returns empty string');
    assertEqual(truncateString(12345), '', 'number returns empty string');

    // Exact length match (no ellipsis)
    assertEqual(truncateString('hello', 5), 'hello', 'exact match not truncated');
    assertEqual(truncateString('hello!', 5), 'he...', 'length + 1 truncated to 5 with ellipsis');

    // Small maxLen (<= 3)
    assertEqual(truncateString('abcdef', 3), '...', 'maxLen 3 produces ...');
    assertEqual(truncateString('abcdef', 2), '...', 'maxLen 2 produces ...');
});

test('QA Edge Case: formatBucketCard handles extreme consumption and missing reset timestamps', () => {
    // 0% remaining
    const exhausted = formatBucketCard({
        bucketId: '3p-weekly',
        remainingFraction: 0.0,
        usedFraction: 1.0,
    });
    assertEqual(exhausted.remainingPercentFormatted, '0%', '0% remaining');
    assertEqual(exhausted.usedPercentFormatted, '100%', '100% used');
    assertEqual(exhausted.health.level, 'crit', '0% is crit');

    // 100% remaining
    const fresh = formatBucketCard({
        bucketId: 'gemini-5h',
        remainingFraction: 1.0,
        usedFraction: 0.0,
    });
    assertEqual(fresh.remainingPercentFormatted, '100%', '100% remaining');
    assertEqual(fresh.usedPercentFormatted, '0%', '0% used');
    assertEqual(fresh.health.level, 'good', '100% is good');

    // Missing reset times
    const noReset = formatBucketCard({
        bucketId: 'gemini-weekly',
        remainingFraction: 0.5,
    });
    assertEqual(noReset.resetText, 'Reinicia em 0m', 'fallback 0m when reset time absent');
});

test('QA Edge Case: formatTopBarText handles all canonical model family variations', () => {
    const models = [
        { displayName: 'Gemini 4 Argon', expectedPrefix: 'Argon:' },
        { displayName: 'Gemini 3.8 Flash', expectedPrefix: 'Flash:' },
        { displayName: 'Claude Opus 5.5', expectedPrefix: 'Opus 5.5:' },
        { displayName: 'Claude Sonnet 5.5', expectedPrefix: 'Sonnet 5.5:' },
        { displayName: 'GPT-OSS 120B', expectedPrefix: 'GPT 120B:' },
    ];

    for (const m of models) {
        const snap = {
            lowestRemainingPercent: 80,
            activeFamily: { displayName: m.displayName },
        };
        const text = formatTopBarText(snap, { includeModel: true });
        assertTrue(
            text.startsWith(m.expectedPrefix),
            `Model "${m.displayName}" should produce prefix "${m.expectedPrefix}", got: "${text}"`
        );
    }
});

test('SEC-UI-01: Header formatting preserves raw strings and prevents HTML expansion', () => {
    const maliciousSnap = {
        projectId: '<script>alert("xss")</script>',
        activeModel: '<img src=x onerror=alert(1)>',
    };
    const header = formatHeaderState(maliciousSnap, true);

    assertTrue(header.projectId.includes('<script>'), 'string kept plain without unescaped interpolation');
    assertTrue(header.activeModel.includes('<img'), 'model kept plain without unescaped interpolation');
});

test('SEC-UI-02: Clean extension lifecycle state management without memory leaks', () => {
    const ext = new ExtensionClass({
        uuid: 'antigravity-usage@wescley.dev',
        path: GLib.get_current_dir() + '/src',
    });

    // 1. Enable initializes subsystems
    ext.enable();
    assertTrue(ext._historyStore !== null, 'historyStore initialized on enable');
    assertTrue(ext._client !== null, 'client initialized on enable');
    assertTrue(ext._scheduler !== null, 'scheduler initialized on enable');

    // 2. Disable cleans up subsystems and nullifies references
    ext.disable();
    assertEqual(ext._historyStore, null, 'historyStore null after disable');
    assertEqual(ext._client, null, 'client null after disable');
    assertEqual(ext._scheduler, null, 'scheduler null after disable');

    // 3. Repeated disable and destroy are idempotent
    ext.disable();
    ext.destroy();
    assertEqual(ext._scheduler, null, 'idempotent cleanup');
});

// -------------------------------------------------------------------------
// QA Automated Regression Tests for Issue #5 Requirements
// -------------------------------------------------------------------------

test('QA-BUG-UI-01: ReloadScheduler contract alignment in extension.js (processChecker and historyStore)', () => {
    const ext = new ExtensionClass({
        uuid: 'antigravity-usage@wescley.dev',
        path: GLib.get_current_dir() + '/src',
    });

    ext.enable();
    try {
        assertTrue(ext._scheduler !== null, 'scheduler is initialized on enable()');
        // ReloadScheduler expects option 'processChecker', but extension.js passed 'processCheckFn'
        assertTrue(
            typeof ext._scheduler._processChecker === 'function',
            'ReloadScheduler must receive a valid processChecker function, got ' + typeof ext._scheduler._processChecker
        );
        // ReloadScheduler should receive historyStore for persisting reloadMode settings
        assertTrue(
            ext._scheduler._historyStore !== null && typeof ext._scheduler._historyStore === 'object',
            'ReloadScheduler must receive historyStore for settings persistence'
        );
    } finally {
        ext.disable();
        ext.destroy();
    }
});

test('QA-BUG-UI-02: Popup quota cards must support both quota groups (gemini and 3p) with consumed %, remaining %, and burn rate', () => {
    const extCode = readProjectFile('src/extension.js');

    // 1. Quota groups requirement: Both Gemini and 3P (Claude & GPT) groups must be rendered
    const rendersBothGroups = extCode.includes('3p-weekly') || extCode.includes('3p-5h') ||
        (extCode.includes('gemini') && extCode.includes('3p') && extCode.includes('groups'));
    assertTrue(
        rendersBothGroups,
        'src/extension.js must render quota cards for both quota groups (gemini and 3p/Claude & GPT)'
    );

    // 2. Average burn rate requirement: %/h, %/dia
    const rendersBurnRate = extCode.includes('burnRateText') || extCode.includes('burnPercentPerHour');
    assertTrue(
        rendersBurnRate,
        'src/extension.js must display average burn rate (%/h, %/dia) on quota cards'
    );

    // 3. Consumed percent requirement: Both used and remaining percent
    const rendersUsedPercent = extCode.includes('usedPercent') || extCode.includes('usedFraction');
    assertTrue(
        rendersUsedPercent,
        'src/extension.js must display consumed percent alongside remaining percent on quota cards'
    );
});

test('QA-BUG-UI-03: Popup controls must include reload mode selector and showPanelPercent toggle', () => {
    const extCode = readProjectFile('src/extension.js');

    // 1. Interactive reload mode selector (Auto, 1m, 5m, 15m, 30m, 1h -> scheduler.setReloadMode)
    const hasReloadModeCall = extCode.includes('setReloadMode');
    assertTrue(
        hasReloadModeCall,
        'src/extension.js must render an interactive reload mode selector hooked to scheduler.setReloadMode'
    );

    const usesReloadMenuOptions = extCode.indexOf('formatReloadMenuOptions', extCode.indexOf('class AntigravityUsageExtension')) !== -1;
    assertTrue(
        usesReloadMenuOptions,
        'src/extension.js must invoke formatReloadMenuOptions to populate reload mode options'
    );

    // 2. Switch for showPanelPercent persisted in HistoryStore
    const hasShowPanelPercent = extCode.includes('showPanelPercent');
    assertTrue(
        hasShowPanelPercent,
        'src/extension.js must include a control and logic for showPanelPercent (hiding/showing numeric percentage on Top Bar)'
    );

    // 3. Top Bar label logic must respect showPanelPercent
    const updateUIIdx = extCode.indexOf('_updateUI(');
    const checksShowPanelPercentInUI = updateUIIdx !== -1 && extCode.slice(updateUIIdx).includes('showPanelPercent');
    assertTrue(
        checksShowPanelPercentInUI,
        'src/extension.js _updateUI must check showPanelPercent before displaying percentage on Top Bar'
    );
});


