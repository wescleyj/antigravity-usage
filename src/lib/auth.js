import Secret from 'gi://Secret?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Generic schema for GNOME Keyring password storage (org.freedesktop.Secret.Generic)
 */
export const GENERIC_SCHEMA = new Secret.Schema(
    'org.freedesktop.Secret.Generic',
    Secret.SchemaFlags.NONE,
    {
        service: Secret.SchemaAttributeType.STRING,
        username: Secret.SchemaAttributeType.STRING,
    }
);

/**
 * Parses an ISO-8601 date string, truncating Go RFC3339Nano 9-digit fractional seconds
 * to 3-digit milliseconds for standard JavaScript Date parsing.
 *
 * @param {string|null} dateStr
 * @returns {number|null} Unix timestamp in milliseconds, or null if invalid
 */
export function parseNanoIsoDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') {
        return null;
    }

    // Truncate any sub-millisecond nanoseconds (e.g. .543148388 -> .543)
    const normalized = dateStr.replace(/(\.\d{3})\d+/, '$1');
    const parsed = Date.parse(normalized);
    if (typeof parsed === 'number' && Number.isFinite(parsed)) {
        return parsed;
    }
    return null;
}

/**
 * Determines whether the stored auth token is expired or within the safety buffer window.
 *
 * @param {object|null} tokenData
 * @param {number} [bufferSec=60] - Safety margin in seconds
 * @param {number} [nowMs=Date.now()]
 * @returns {boolean}
 */
export function isTokenExpired(tokenData, bufferSec = 60, nowMs = Date.now()) {
    if (!tokenData || typeof tokenData !== 'object') {
        return true;
    }
    if (!tokenData.accessToken || typeof tokenData.accessToken !== 'string' || tokenData.accessToken.trim() === '') {
        return true;
    }
    if (typeof tokenData.expiryMs !== 'number' || !Number.isFinite(tokenData.expiryMs)) {
        return true;
    }
    const validBufferSec = (typeof bufferSec === 'number' && Number.isFinite(bufferSec)) ? Math.max(0, bufferSec) : 60;
    const validNowMs = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
    const bufferMs = validBufferSec * 1000;
    return (tokenData.expiryMs - validNowMs) <= bufferMs;
}

/**
 * Retrieves the OAuth credential from GNOME Keyring for service='gemini', username='antigravity'.
 * Never exposes token contents in error messages.
 *
 * @param {Function|null} [secretLookupFn=null] - Injected lookup function for testing
 * @returns {{ accessToken: string, expiryMs: number|null, expiryRaw: string|null, tokenType: string, refreshToken: string|null }}
 */
export function getKeyringAuthToken(secretLookupFn = null) {
    let rawSecret = null;
    if (typeof secretLookupFn === 'function') {
        try {
            rawSecret = secretLookupFn({ service: 'gemini', username: 'antigravity' });
        } catch (err) {
            throw new Error('Failed to retrieve secret from GNOME Keyring');
        }
    } else {
        try {
            rawSecret = Secret.password_lookup_sync(GENERIC_SCHEMA, { service: 'gemini', username: 'antigravity' }, null);
        } catch (err) {
            throw new Error('Failed to retrieve secret from GNOME Keyring');
        }
    }

    if (!rawSecret || typeof rawSecret !== 'string') {
        throw new Error('Antigravity credentials not found in GNOME Keyring (service=gemini, username=antigravity)');
    }

    let parsed;
    try {
        parsed = JSON.parse(rawSecret);
    } catch (e) {
        throw new Error('Invalid JSON format in stored Keyring credentials');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Credentials payload is not a valid object');
    }

    const tokenObj = (parsed.token && typeof parsed.token === 'object' && !Array.isArray(parsed.token)) ? parsed.token : parsed;
    const accessToken = tokenObj.access_token || tokenObj.accessToken;
    if (!accessToken || typeof accessToken !== 'string' || accessToken.trim() === '') {
        throw new Error('Access token not found in stored credentials');
    }

    const expiryRaw = tokenObj.expiry || tokenObj.expiryTime || parsed.expiry || null;
    const expiryMs = parseNanoIsoDate(expiryRaw);

    return {
        accessToken: accessToken.trim(),
        expiryMs,
        expiryRaw,
        tokenType: tokenObj.token_type || 'Bearer',
        refreshToken: tokenObj.refresh_token || null,
        idToken: parsed.id_token || null,
        authMethod: parsed.auth_method || null,
    };
}

/**
 * Asynchronously executes `agy models` via Gio.Subprocess with a fixed arguments array (no shell)
 * to trigger the official CLI credential refresh in the Keyring.
 *
 * @param {Function|null} [subprocessRunnerFn=null] - Injected runner for testing
 * @returns {Promise<boolean>}
 */
export async function refreshTokenViaAgyCli(subprocessRunnerFn = null) {
    const fixedArgs = ['agy', 'models'];

    if (typeof subprocessRunnerFn === 'function') {
        const res = await subprocessRunnerFn(fixedArgs);
        return res;
    }

    const binPath = GLib.find_program_in_path('agy') ||
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'agy']);

    if (!binPath || !GLib.file_test(binPath, GLib.FileTest.IS_EXECUTABLE)) {
        throw new Error(`Antigravity CLI binary "agy" not found or not executable at: ${binPath || 'PATH'}`);
    }

    const argv = [binPath, 'models'];

    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
        } catch (initErr) {
            reject(new Error(`Failed to launch agy CLI process: ${initErr.message}`));
            return;
        }

        proc.wait_check_async(null, (procObj, res) => {
            try {
                procObj.wait_check_finish(res);
                resolve(true);
            } catch (waitErr) {
                reject(new Error(`agy CLI exited with non-zero status during token refresh`));
            }
        });
    });
}

/**
 * Coordinates cached token retrieval, expiration checking, and concurrent refresh deduplication.
 */
export class AuthManager {
    /**
     * @param {object} params
     * @param {Function|null} [params.secretLookupFn=null]
     * @param {Function|null} [params.subprocessRunnerFn=null]
     * @param {Function} [params.nowFn=Date.now]
     * @param {number} [params.bufferSec=60]
     */
    constructor({
        secretLookupFn = null,
        subprocessRunnerFn = null,
        nowFn = Date.now,
        bufferSec = 60,
    } = {}) {
        this._secretLookupFn = secretLookupFn;
        this._subprocessRunnerFn = subprocessRunnerFn;
        this._nowFn = nowFn;
        this._bufferSec = bufferSec;
        this._cachedToken = null;
        this._refreshPromise = null;
    }

    /**
     * Retrieves a valid Bearer token, refreshing via CLI if expired or explicitly forced.
     *
     * @param {object} [options={}]
     * @param {boolean} [options.forceRefresh=false]
     * @returns {Promise<string>} Access token string
     */
    async getValidToken({ forceRefresh = false } = {}) {
        if (!forceRefresh && this._cachedToken && !isTokenExpired(this._cachedToken, this._bufferSec, this._nowFn())) {
            return this._cachedToken.accessToken;
        }

        if (!forceRefresh && !this._cachedToken) {
            try {
                const token = getKeyringAuthToken(this._secretLookupFn);
                this._cachedToken = token;
                if (!isTokenExpired(token, this._bufferSec, this._nowFn())) {
                    return token.accessToken;
                }
            } catch (err) {
                // If reading fails or token is expired, trigger refresh below
            }
        }

        const refreshed = await this.forceRefreshToken();
        return refreshed.accessToken;
    }

    /**
     * Forces token refresh via CLI and reloads from Keyring with mutex locking.
     *
     * @returns {Promise<object>} Refreshed token object
     */
    async forceRefreshToken() {
        if (this._refreshPromise) {
            return this._refreshPromise;
        }

        this._refreshPromise = (async () => {
            try {
                await refreshTokenViaAgyCli(this._subprocessRunnerFn);
                const token = getKeyringAuthToken(this._secretLookupFn);
                this._cachedToken = token;
                return token;
            } finally {
                this._refreshPromise = null;
            }
        })();

        return this._refreshPromise;
    }

    /**
     * Retrieves cached token object.
     *
     * @returns {object|null}
     */
    getCachedToken() {
        return this._cachedToken;
    }

    /**
     * Clears token cache.
     */
    clearCache() {
        this._cachedToken = null;
    }
}
