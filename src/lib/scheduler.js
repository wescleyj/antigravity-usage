import GLib from 'gi://GLib';

/**
 * Available reload options for UI popup menu
 */
export const RELOAD_OPTIONS = Object.freeze([
    Object.freeze({ id: 'auto', label: '⚡ Auto (3m CLI aberto • 30m fechado)' }),
    Object.freeze({ id: 60, label: '1 minuto' }),
    Object.freeze({ id: 300, label: '5 minutos' }),
    Object.freeze({ id: 900, label: '15 minutos' }),
    Object.freeze({ id: 1800, label: '30 minutos' }),
    Object.freeze({ id: 3600, label: '1 hora' }),
]);

/**
 * Computes the effective timer interval in seconds based on user settings and process state.
 *
 * @param {object} [settings={}] - User settings (reloadMode, autoActiveSec, autoIdleSec)
 * @param {boolean} [isAgyRunning=false] - Whether CLI process is running
 * @returns {number} Effective interval in seconds
 */
export function computeEffectiveIntervalSec(settings = {}, isAgyRunning = false) {
    const mode = settings ? settings.reloadMode : 'auto';
    if (mode === 'auto' || mode === undefined || mode === null) {
        const activeSec = (settings && typeof settings.autoActiveSec === 'number' && Number.isFinite(settings.autoActiveSec))
            ? Math.max(60, Math.min(3600, Math.round(settings.autoActiveSec)))
            : 180;
        const idleSec = (settings && typeof settings.autoIdleSec === 'number' && Number.isFinite(settings.autoIdleSec))
            ? Math.max(300, Math.min(7200, Math.round(settings.autoIdleSec)))
            : 1800;
        return Boolean(isAgyRunning) ? activeSec : idleSec;
    }

    const numMode = Number(mode);
    if (Number.isFinite(numMode)) {
        return Math.max(60, Math.min(3600, Math.round(numMode)));
    }

    return 180;
}

/**
 * Production timer backend utilizing GNOME GLib main loop.
 */
export class GLibTimerBackend {
    timeoutAddSeconds(priority, intervalSec, callback) {
        return GLib.timeout_add_seconds(priority, intervalSec, callback);
    }

    sourceRemove(sourceId) {
        if (sourceId) {
            GLib.Source.remove(sourceId);
        }
    }
}

/**
 * Virtual timer backend for fast, deterministic, zero-waiting testing.
 */
export class VirtualTimerBackend {
    constructor() {
        this._currentTime = 0;
        this._nextId = 1;
        this._timers = new Map();
    }

    timeoutAddSeconds(priority, intervalSec, callback) {
        const id = this._nextId++;
        this._timers.set(id, {
            id,
            priority,
            intervalSec,
            callback,
            nextRun: this._currentTime + intervalSec,
        });
        return id;
    }

    sourceRemove(sourceId) {
        return this._timers.delete(sourceId);
    }

    advanceTime(seconds) {
        this._currentTime += seconds;
        let hadDue = true;
        while (hadDue) {
            hadDue = false;
            const dueTimers = [];
            for (const timer of this._timers.values()) {
                if (timer.nextRun <= this._currentTime) {
                    dueTimers.push(timer);
                }
            }
            dueTimers.sort((a, b) => a.nextRun - b.nextRun);

            for (const timer of dueTimers) {
                if (!this._timers.has(timer.id)) continue;
                hadDue = true;
                const result = timer.callback();
                if (result === true || result === GLib.SOURCE_CONTINUE) {
                    timer.nextRun += timer.intervalSec;
                } else {
                    this._timers.delete(timer.id);
                }
            }
        }
    }

    getTime() {
        return this._currentTime;
    }

    clear() {
        this._timers.clear();
    }
}

/**
 * Adaptive reload scheduler managing automatic and manual quota refresh cycles.
 */
export class ReloadScheduler {
    /**
     * @param {object} params
     * @param {Function} [params.onReload]
     * @param {Function} [params.onRefresh]
     * @param {object} [params.historyStore=null]
     * @param {Function} [params.processChecker=null]
     * @param {object} [params.timerBackend=null]
     * @param {number} [params.watcherIntervalSec=60]
     */
    constructor({
        onReload,
        onRefresh,
        historyStore = null,
        processChecker = null,
        timerBackend = null,
        watcherIntervalSec = 60,
    } = {}) {
        this._callback = onRefresh || onReload || null;
        this._historyStore = historyStore;
        this._processChecker = processChecker;
        this._timerBackend = timerBackend || new GLibTimerBackend();

        const validWatcher = (typeof watcherIntervalSec === 'number' && Number.isFinite(watcherIntervalSec))
            ? watcherIntervalSec
            : 60;
        this._watcherIntervalSec = Math.max(10, Math.min(300, Math.round(validWatcher)));

        this._reloadMode = this._historyStore ? this._historyStore.getSettings().reloadMode : 'auto';
        this._isAgyRunning = false;
        this._started = false;
        this._destroyed = false;
        this._isReloading = false;
        this._reloadTimerId = null;
        this._watcherTimerId = null;
    }

    /**
     * Starts the scheduler and active process watcher.
     *
     * @param {object} [options={}]
     * @param {boolean} [options.triggerImmediate=false]
     */
    start({ triggerImmediate = false } = {}) {
        if (this._destroyed || this._started) {
            return;
        }
        this._started = true;

        // Initial process check
        if (typeof this._processChecker === 'function') {
            try {
                const res = this._processChecker();
                this._isAgyRunning = (res && typeof res === 'object') ? Boolean(res.running) : Boolean(res);
            } catch (err) {
                this._isAgyRunning = false;
            }
        }

        this._scheduleNextReload();
        this._startWatcher();

        if (triggerImmediate) {
            this.forceRefresh();
        }
    }

    /**
     * Stops all active timers.
     */
    stop() {
        this._started = false;
        this._clearReloadTimer();
        this._clearWatcherTimer();
    }

    /**
     * Destroys the scheduler, clearing timers and releasing references.
     */
    destroy() {
        this._destroyed = true;
        this.stop();
        this._callback = null;
        this._processChecker = null;
        this._historyStore = null;
    }

    /**
     * Cancels pending timers, triggers reload immediately, and reschedules next cycle.
     * Prevents concurrent overlapping reloads.
     *
     * @returns {Promise<void>|void}
     */
    forceRefresh() {
        if (this._destroyed || this._isReloading) {
            return Promise.resolve();
        }

        this._isReloading = true;
        this._clearReloadTimer();

        let promiseOrVal;
        try {
            if (typeof this._callback === 'function') {
                promiseOrVal = this._callback();
            }
        } catch (err) {
            console.error(`ReloadScheduler: error during reload: ${err}`);
        }

        const finalize = () => {
            this._isReloading = false;
            if (!this._destroyed && this._started) {
                this._scheduleNextReload();
            }
        };

        if (promiseOrVal && typeof promiseOrVal.then === 'function') {
            return promiseOrVal.catch(err => {
                console.error(`ReloadScheduler: error during reload: ${err}`);
            }).finally(finalize);
        } else {
            finalize();
            return Promise.resolve();
        }
    }

    /**
     * Alias for forceRefresh.
     *
     * @returns {Promise<void>}
     */
    forceReload() {
        return this.forceRefresh();
    }

    /**
     * Schedules the next reload timer.
     */
    _scheduleNextReload() {
        this._clearReloadTimer();
        if (this._destroyed || !this._started) {
            return;
        }

        const intervalSec = this.getCurrentIntervalSec();
        this._reloadTimerId = this._timerBackend.timeoutAddSeconds(
            GLib.PRIORITY_DEFAULT,
            intervalSec,
            () => {
                this._reloadTimerId = null;
                this.forceRefresh();
                return false;
            }
        );
    }

    /**
     * Clears the reload timer source.
     */
    _clearReloadTimer() {
        if (this._reloadTimerId !== null) {
            this._timerBackend.sourceRemove(this._reloadTimerId);
            this._reloadTimerId = null;
        }
    }

    /**
     * Starts the periodic process watcher.
     */
    _startWatcher() {
        this._clearWatcherTimer();
        if (this._destroyed || !this._started) {
            return;
        }

        this._watcherTimerId = this._timerBackend.timeoutAddSeconds(
            GLib.PRIORITY_DEFAULT_IDLE,
            this._watcherIntervalSec,
            () => {
                this._checkProcessState();
                return true;
            }
        );
    }

    /**
     * Clears the watcher timer source.
     */
    _clearWatcherTimer() {
        if (this._watcherTimerId !== null) {
            this._timerBackend.sourceRemove(this._watcherTimerId);
            this._watcherTimerId = null;
        }
    }

    /**
     * Periodic watcher execution checking process state transitions.
     */
    _checkProcessState() {
        if (typeof this._processChecker !== 'function') {
            return;
        }

        let isRunning = false;
        try {
            const res = this._processChecker();
            isRunning = (res && typeof res === 'object') ? Boolean(res.running) : Boolean(res);
        } catch (err) {
            isRunning = false;
        }

        const prevRunning = this._isAgyRunning;
        this._isAgyRunning = isRunning;

        const mode = this.getReloadMode();
        if (mode === 'auto') {
            if (!prevRunning && isRunning) {
                // Closed -> Open transition: trigger immediate refresh and switch to active interval
                this.forceRefresh();
            } else if (prevRunning && !isRunning) {
                // Open -> Closed transition: adjust timer to idle interval
                this._scheduleNextReload();
            }
        }
    }

    /**
     * Updates reload mode ('auto' | 60 | 300 | 900 | 1800 | 3600).
     *
     * @param {string|number} mode
     */
    setReloadMode(mode) {
        if (this._destroyed) {
            return;
        }
        this._reloadMode = mode;
        if (this._historyStore) {
            this._historyStore.updateSettings({ reloadMode: mode });
        }
        if (this._started) {
            this._scheduleNextReload();
        }
    }

    /**
     * Retrieves current reload mode.
     *
     * @returns {string|number}
     */
    getReloadMode() {
        if (this._historyStore) {
            return this._historyStore.getSettings().reloadMode;
        }
        return this._reloadMode;
    }

    /**
     * Retrieves effective interval in seconds.
     *
     * @returns {number}
     */
    getCurrentIntervalSec() {
        const settings = this._historyStore
            ? this._historyStore.getSettings()
            : { reloadMode: this._reloadMode };
        return computeEffectiveIntervalSec(settings, this._isAgyRunning);
    }

    /**
     * Returns whether the CLI process is currently known to be running.
     *
     * @returns {boolean}
     */
    isAgyRunning() {
        return this._isAgyRunning;
    }

    /**
     * Retrieves snapshot of scheduler state.
     *
     * @returns {object}
     */
    getState() {
        return {
            reloadMode: this.getReloadMode(),
            currentIntervalSec: this.getCurrentIntervalSec(),
            isAgyRunning: this._isAgyRunning,
            isRunning: this._started,
            isReloading: this._isReloading,
            isDestroyed: this._destroyed,
        };
    }
}
