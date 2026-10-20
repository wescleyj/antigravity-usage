import GLib from 'gi://GLib';

/**
 * Default user settings as defined in docs/SCHEMA.md
 */
export const DEFAULT_SETTINGS = Object.freeze({
    reloadMode: 'auto',
    autoActiveSec: 180,
    autoIdleSec: 1800,
    showPanelPercent: true,
});

export const RETENTION_MS = 8 * 24 * 3600 * 1000; // 8 days
export const MAX_SAMPLES_PER_BUCKET = 500;
export const MAX_BUCKETS = 50;
export const DEDUP_MIN_DELTA = 0.0001;
export const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
export const RESET_DELTA_THRESHOLD = 0.02; // 2% jump indicates quota reset
export const HISTORY_WINDOW_MS = 6 * 3600 * 1000; // 6 hours
export const MIN_HISTORY_DT_MS = 3 * 60 * 1000; // 3 minutes

export const BUCKET_ID_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;

export const FORBIDDEN_KEYS = new Set([
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
]);

/**
 * Formats a duration in milliseconds into a compact human-readable pt-BR string.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} - e.g., '2d 7h', '4h 15m', '38m', '< 1m', 'Agora'
 */
export function formatDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
        return 'Agora';
    }

    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;

    if (ms < MINUTE) {
        return '< 1m';
    }

    if (ms < HOUR) {
        const m = Math.floor(ms / MINUTE);
        return `${m}m`;
    }

    if (ms < DAY) {
        const h = Math.floor(ms / HOUR);
        const m = Math.floor((ms % HOUR) / MINUTE);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }

    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms % DAY) / HOUR);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Sanitizes user settings, preventing prototype pollution and illegal fields.
 *
 * @param {object} partial
 * @param {object} [base=DEFAULT_SETTINGS]
 * @returns {object}
 */
export function sanitizeSettings(partial, base = DEFAULT_SETTINGS) {
    const result = {
        reloadMode: (base && base.reloadMode !== undefined) ? base.reloadMode : DEFAULT_SETTINGS.reloadMode,
        autoActiveSec: (base && base.autoActiveSec !== undefined) ? base.autoActiveSec : DEFAULT_SETTINGS.autoActiveSec,
        autoIdleSec: (base && base.autoIdleSec !== undefined) ? base.autoIdleSec : DEFAULT_SETTINGS.autoIdleSec,
        showPanelPercent: (base && base.showPanelPercent !== undefined) ? base.showPanelPercent : DEFAULT_SETTINGS.showPanelPercent,
    };

    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
        return result;
    }

    if (Object.hasOwn(partial, 'reloadMode')) {
        const val = partial.reloadMode;
        if (val === 'auto' || (typeof val === 'number' && Number.isFinite(val) && val >= 30 && val <= 86400)) {
            result.reloadMode = val;
        }
    }

    if (Object.hasOwn(partial, 'autoActiveSec')) {
        const val = partial.autoActiveSec;
        if (typeof val === 'number' && Number.isFinite(val) && val >= 30 && val <= 7200) {
            result.autoActiveSec = val;
        }
    }

    if (Object.hasOwn(partial, 'autoIdleSec')) {
        const val = partial.autoIdleSec;
        if (typeof val === 'number' && Number.isFinite(val) && val >= 60 && val <= 86400) {
            result.autoIdleSec = val;
        }
    }

    if (Object.hasOwn(partial, 'showPanelPercent')) {
        const val = partial.showPanelPercent;
        if (typeof val === 'boolean') {
            result.showPanelPercent = val;
        }
    }

    return result;
}

/**
 * Manages quota usage history persistence and burn rate / autonomy calculations.
 */
export class UsageHistoryStore {
    /**
     * @param {string|null} customFilePath - Custom path for history.json
     */
    constructor(customFilePath = null) {
        if (customFilePath) {
            this._filePath = customFilePath;
        } else {
            const envPath = GLib.getenv('ANTIGRAVITY_USAGE_HISTORY_PATH');
            if (envPath) {
                this._filePath = envPath;
            } else {
                this._filePath = GLib.build_filenamev([
                    GLib.get_user_data_dir(),
                    'antigravity-usage',
                    'history.json',
                ]);
            }
        }

        this._ensureParentDir();
        this._data = {
            version: 1,
            settings: sanitizeSettings(null, DEFAULT_SETTINGS),
            buckets: Object.create(null),
        };

        this.load();
    }

    /**
     * Ensures parent directory exists with 0o700 permissions.
     */
    _ensureParentDir() {
        const dir = GLib.path_get_dirname(this._filePath);
        if (dir) {
            if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
                GLib.mkdir_with_parents(dir, 0o700);
            }
            GLib.chmod(dir, 0o700);
        }
    }

    /**
     * Loads history data and settings from disk safely.
     */
    load() {
        if (!GLib.file_test(this._filePath, GLib.FileTest.EXISTS)) {
            return;
        }

        try {
            const [ok, data] = GLib.file_get_contents(this._filePath);
            if (!ok) {
                return;
            }
            const text = new TextDecoder('utf-8').decode(data);
            const parsed = JSON.parse(text);

            const loadedBuckets = Object.create(null);
            if (parsed && parsed.buckets && typeof parsed.buckets === 'object' && !Array.isArray(parsed.buckets)) {
                for (const [key, samples] of Object.entries(parsed.buckets)) {
                    if (typeof key === 'string' && BUCKET_ID_REGEX.test(key) && !FORBIDDEN_KEYS.has(key) && Array.isArray(samples)) {
                        loadedBuckets[key] = samples.filter(s =>
                            s &&
                            typeof s.t === 'number' && Number.isFinite(s.t) &&
                            typeof s.r === 'number' && Number.isFinite(s.r)
                        );
                    }
                }
            }

            this._data = {
                version: (parsed && typeof parsed.version === 'number') ? parsed.version : 1,
                settings: sanitizeSettings(parsed ? parsed.settings : null, DEFAULT_SETTINGS),
                buckets: loadedBuckets,
            };
        } catch (err) {
            // If the file is corrupt or unreadable, retain safe defaults
            this._data = {
                version: 1,
                settings: sanitizeSettings(null, DEFAULT_SETTINGS),
                buckets: Object.create(null),
            };
        }
    }

    /**
     * Persists history data and settings to disk atomically with 0o600 permissions.
     */
    save() {
        this._ensureParentDir();
        const json = JSON.stringify(this._data, null, 2);
        GLib.file_set_contents(this._filePath, json);
        GLib.chmod(this._filePath, 0o600);
    }

    /**
     * Returns a copy of current user settings.
     *
     * @returns {object}
     */
    getSettings() {
        return { ...this._data.settings };
    }

    /**
     * Updates settings with partial values and saves to disk.
     *
     * @param {object} partial
     * @returns {object}
     */
    updateSettings(partial) {
        this._data.settings = sanitizeSettings(partial, this._data.settings);
        this.save();
        return this.getSettings();
    }

    /**
     * Records a new sample for a quota bucket.
     * Handles deduplication, cycle reset detection, and retention pruning.
     *
     * @param {string} bucketId
     * @param {number} remainingFraction
     * @param {string|null} resetTimeIso
     * @param {number} nowMs
     * @returns {boolean} True if recorded, false if deduplicated or rejected
     */
    recordSample(bucketId, remainingFraction, resetTimeIso, nowMs = Date.now()) {
        if (typeof bucketId !== 'string' || !BUCKET_ID_REGEX.test(bucketId) || FORBIDDEN_KEYS.has(bucketId)) {
            throw new Error('Invalid bucketId: must match /^[a-zA-Z0-9_.-]{1,64}$/ and not be reserved');
        }

        if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs <= 0) {
            throw new Error('nowMs must be a positive finite number');
        }

        if (typeof remainingFraction !== 'number' || Number.isNaN(remainingFraction)) {
            return false;
        }

        const clampedRemaining = Math.max(0, Math.min(1, remainingFraction));
        const resetIso = (typeof resetTimeIso === 'string') ? resetTimeIso : null;

        // Check bucket capacity before creating a new bucket
        if (!Object.hasOwn(this._data.buckets, bucketId)) {
            const bucketKeys = Object.keys(this._data.buckets);
            if (bucketKeys.length >= MAX_BUCKETS) {
                let oldestKey = bucketKeys[0];
                let oldestTime = Infinity;
                for (const key of bucketKeys) {
                    const samples = this._data.buckets[key];
                    const lastT = (samples && samples.length > 0) ? samples[samples.length - 1].t : 0;
                    if (lastT < oldestTime) {
                        oldestTime = lastT;
                        oldestKey = key;
                    }
                }
                delete this._data.buckets[oldestKey];
            }
            this._data.buckets[bucketId] = [];
        }

        const bucket = this._data.buckets[bucketId];
        let last = null;
        for (let i = bucket.length - 1; i >= 0; i--) {
            const s = bucket[i];
            if (s && typeof s.r === 'number' && Number.isFinite(s.r)) {
                last = s;
                break;
            }
        }

        if (last) {
            // Detecção de Reinício de Ciclo (Quota Reset):
            // Só avalia se last.r for número finito válido
            if (typeof last.r === 'number' && Number.isFinite(last.r) && (clampedRemaining - last.r > RESET_DELTA_THRESHOLD)) {
                this._data.buckets[bucketId] = [];
            } else {
                // Deduplicação de Amostras
                const sameReset = (last.resetTime === resetIso);
                const smallDelta = Math.abs(clampedRemaining - last.r) < DEDUP_MIN_DELTA;
                const within10m = (nowMs - last.t) >= 0 && (nowMs - last.t) < DEDUP_WINDOW_MS;

                if (sameReset && smallDelta && within10m) {
                    return false;
                }
            }
        }

        // Retenção e Limite de Memória (Pruning): descarta amostras com mais de 8 dias ou inválidas
        let activeBucket = this._data.buckets[bucketId].filter(
            s => s &&
                typeof s.t === 'number' && Number.isFinite(s.t) &&
                typeof s.r === 'number' && Number.isFinite(s.r) &&
                (nowMs - s.t) <= RETENTION_MS
        );

        activeBucket.push({
            t: nowMs,
            r: clampedRemaining,
            resetTime: resetIso,
        });

        // Limita ao máximo de 500 amostras por bucket
        if (activeBucket.length > MAX_SAMPLES_PER_BUCKET) {
            activeBucket = activeBucket.slice(-MAX_SAMPLES_PER_BUCKET);
        }

        this._data.buckets[bucketId] = activeBucket;
        this.save();
        return true;
    }

    /**
     * Clears all samples for a specific bucket.
     *
     * @param {string} bucketId
     */
    clearBucket(bucketId) {
        if (typeof bucketId === 'string' && Object.hasOwn(this._data.buckets, bucketId)) {
            delete this._data.buckets[bucketId];
            this.save();
        }
    }

    /**
     * Clears all buckets in the history.
     */
    clearAll() {
        this._data.buckets = Object.create(null);
        this.save();
    }

    /**
     * Returns raw samples for a bucket.
     *
     * @param {string} bucketId
     * @returns {Array}
     */
    getSamples(bucketId) {
        if (typeof bucketId === 'string' && Object.hasOwn(this._data.buckets, bucketId)) {
            return this._data.buckets[bucketId].slice();
        }
        return [];
    }

    /**
     * Analyzes quota bucket burn rate and autonomy estimation.
     *
     * @param {object} params
     * @param {string} params.bucketId
     * @param {number} [params.remainingFraction]
     * @param {string|null} [params.resetTimeIso]
     * @param {string} [params.windowType='weekly'] - 'weekly' | '5h'
     * @param {number} [params.nowMs=Date.now()]
     * @returns {object} Analysis result
     */
    analyzeBucket({
        bucketId,
        remainingFraction,
        resetTimeIso,
        windowType = 'weekly',
        nowMs = Date.now(),
    }) {
        if (typeof bucketId !== 'string' || !BUCKET_ID_REGEX.test(bucketId) || FORBIDDEN_KEYS.has(bucketId)) {
            throw new Error('Invalid bucketId: must match /^[a-zA-Z0-9_.-]{1,64}$/ and not be reserved');
        }

        const bucketSamples = (Object.hasOwn(this._data.buckets, bucketId) ? this._data.buckets[bucketId] : []).filter(
            s => s && typeof s.r === 'number' && Number.isFinite(s.r)
        );
        const lastSample = bucketSamples.length > 0 ? bucketSamples[bucketSamples.length - 1] : null;

        let r = remainingFraction;
        if (typeof r !== 'number' || Number.isNaN(r)) {
            r = (lastSample && typeof lastSample.r === 'number' && Number.isFinite(lastSample.r)) ? lastSample.r : 1.0;
        }
        r = Math.max(0, Math.min(1, r));

        let resetIso = resetTimeIso;
        if (typeof resetIso !== 'string') {
            resetIso = lastSample ? lastSample.resetTime : null;
        }

        const usedFraction = Math.max(0, Math.min(1, 1 - r));
        const remainingPercent = r * 100;
        const usedPercent = usedFraction * 100;

        let resetTimeMs = 0;
        if (typeof resetIso === 'string') {
            const parsedMs = Date.parse(resetIso);
            if (Number.isFinite(parsedMs)) {
                resetTimeMs = parsedMs;
            }
        }
        const resetInMs = resetTimeMs > 0 ? Math.max(0, resetTimeMs - nowMs) : 0;
        const resetInFormatted = formatDuration(resetInMs);

        // Window duration: 5h = 5 hours, weekly = 168 hours
        const windowHours = (windowType === '5h') ? 5 : 168;
        const windowMs = windowHours * 3600 * 1000;

        // 1. Taxa Base do Ciclo (cycleBurnPerHour)
        let cycleBurnPerHour = 0;
        const elapsedMs = windowMs - resetInMs;
        if (elapsedMs > 0 && resetInMs <= windowMs) {
            const elapsedHours = elapsedMs / (3600 * 1000);
            if (elapsedHours > 0 && usedFraction > 0) {
                cycleBurnPerHour = usedFraction / elapsedHours;
            }
        }

        // 2. Taxa Histórica Recente (historyBurnPerHour)
        // Amostras registradas na janela recente (últimas 6 horas) do ciclo atual
        const sixHoursAgo = nowMs - HISTORY_WINDOW_MS;
        const recentSamples = bucketSamples.filter(s => {
            if (s.t < sixHoursAgo || s.t > nowMs) return false;
            if (resetIso && s.resetTime && s.resetTime !== resetIso) return false;
            return true;
        });
        recentSamples.sort((a, b) => a.t - b.t);

        let historyBurnPerHour = 0;
        if (recentSamples.length >= 2) {
            const first = recentSamples[0];
            const last = recentSamples[recentSamples.length - 1];
            const dtMs = last.t - first.t;
            const dr = first.r - last.r;
            const dtHours = dtMs / (3600 * 1000);

            if (dtMs >= MIN_HISTORY_DT_MS && dr >= 0 && dtHours > 0) {
                historyBurnPerHour = dr / dtHours;
            }
        }

        // 3. Taxa Efetiva Híbrida (effectiveBurnPerHour)
        // Se houver tanto historyBurnPerHour > 0 quanto cycleBurnPerHour > 0: 65% / 35%
        let effectiveBurnPerHour = 0;
        if (historyBurnPerHour > 0 && cycleBurnPerHour > 0) {
            effectiveBurnPerHour = (0.65 * historyBurnPerHour) + (0.35 * cycleBurnPerHour);
        } else if (historyBurnPerHour > 0) {
            effectiveBurnPerHour = historyBurnPerHour;
        } else if (cycleBurnPerHour > 0) {
            effectiveBurnPerHour = cycleBurnPerHour;
        }

        const burnPercentPerHour = effectiveBurnPerHour * 100;
        const burnPercentPerDay = burnPercentPerHour * 24;

        // 4. Autonomia Estimada e Alerta de Esgotamento
        let estimatedDurationMs = null;
        let estimatedDurationFormatted = null;
        let willExhaustBeforeReset = false;
        let estimatedLabel = 'Seguro até o reset';

        if (r <= 0) {
            estimatedDurationMs = 0;
            estimatedDurationFormatted = formatDuration(0);
            willExhaustBeforeReset = resetInMs > 0;
            estimatedLabel = 'Esgotado';
        } else if (effectiveBurnPerHour > 0) {
            const hours = r / effectiveBurnPerHour;
            estimatedDurationMs = Math.round(hours * 3600 * 1000);
            estimatedDurationFormatted = formatDuration(estimatedDurationMs);
            willExhaustBeforeReset = estimatedDurationMs < resetInMs;
            estimatedLabel = willExhaustBeforeReset ? 'Esgota antes do reset' : 'Seguro até o reset';
        }

        return {
            bucketId,
            windowType,
            remainingFraction: r,
            usedFraction,
            remainingPercent,
            usedPercent,
            resetTimeIso: resetIso,
            resetInMs,
            resetInFormatted,
            burnPercentPerHour,
            burnPercentPerDay,
            estimatedDurationMs,
            estimatedDurationFormatted,
            estimatedLabel,
            willExhaustBeforeReset,
            sampleCount: bucketSamples.length,
        };
    }
}

export const HistoryStore = UsageHistoryStore;
