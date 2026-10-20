import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { AuthManager } from './auth.js';
import { formatDuration } from './history.js';
import { getAgyLocalConfig } from './processMonitor.js';

/**
 * 5 Canonical Model Families defined by Antigravity CLI with deep freeze protection
 */
export const AGY_MODEL_FAMILIES = Object.freeze([
    Object.freeze({
        id: 'gemini-4-argon',
        displayName: 'Gemini 4 Argon',
        group: 'gemini',
        defaultTier: 'Medium',
        apiModelKeys: Object.freeze(['gemini-4-argon', 'gemini-4-argon-medium']),
    }),
    Object.freeze({
        id: 'gemini-3.8-flash',
        displayName: 'Gemini 3.8 Flash',
        group: 'gemini',
        defaultTier: 'Tiered',
        apiModelKeys: Object.freeze(['gemini-3.8-flash', 'gemini-3.8-flash-tiered']),
    }),
    Object.freeze({
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        group: '3p',
        defaultTier: 'Medium',
        apiModelKeys: Object.freeze(['claude-opus-5-5', 'claude-opus-5-5-medium', 'claude-opus-5.5']),
    }),
    Object.freeze({
        id: 'claude-sonnet-5-5',
        displayName: 'Claude Sonnet 5.5',
        group: '3p',
        defaultTier: 'Medium',
        apiModelKeys: Object.freeze(['claude-sonnet-5-5', 'claude-sonnet-5-5-medium', 'claude-sonnet-5.5']),
    }),
    Object.freeze({
        id: 'gpt-oss-120b',
        displayName: 'GPT-OSS 120B',
        group: '3p',
        defaultTier: 'Standard',
        apiModelKeys: Object.freeze(['gpt-oss-120b', 'gpt-oss-120b-standard']),
    }),
]);

/**
 * Whitelist of permitted CloudCode API hosts to prevent SSRF and credential exfiltration
 */
export const ALLOWED_API_HOSTS = Object.freeze(new Set([
    'cloudcode-pa.googleapis.com',
    'daily-cloudcode-pa.googleapis.com',
]));

/**
 * Maximum allowed response body size (5 MB) to prevent DoS / memory exhaustion
 */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * HTTP Client for Google CloudCode Quota API (cloudcode-pa.googleapis.com)
 */
export class AntigravityQuotaClient {
    /**
     * @param {object|UsageHistoryStore} [optionsOrHistoryStore={}]
     */
    constructor(optionsOrHistoryStore = {}) {
        let options = {};
        if (optionsOrHistoryStore && typeof optionsOrHistoryStore === 'object') {
            if (typeof optionsOrHistoryStore.recordSample === 'function' && typeof optionsOrHistoryStore.analyzeBucket === 'function') {
                options = { historyStore: optionsOrHistoryStore };
            } else {
                options = optionsOrHistoryStore;
            }
        }

        let rawUrl = GLib.getenv('CLOUDCODE_API_BASE_URL') || 'https://cloudcode-pa.googleapis.com';
        if (options && Object.hasOwn(options, 'baseUrl')) {
            rawUrl = options.baseUrl;
        }

        if (typeof rawUrl !== 'string' || !rawUrl.startsWith('https://')) {
            throw new Error('Base URL must start with https:// to protect credentials in transit');
        }

        let uri;
        try {
            uri = GLib.Uri.parse(rawUrl, GLib.UriFlags.NONE);
        } catch (e) {
            throw new Error(`Invalid Base URL format: ${e.message}`);
        }

        const host = uri ? uri.get_host() : null;
        const allowCustomHost = Boolean(options && options.allowCustomHost);
        if (!allowCustomHost && (!host || !ALLOWED_API_HOSTS.has(host))) {
            throw new Error(`Base URL host "${host}" is not in the allowed API whitelist`);
        }

        this._baseUrl = rawUrl.replace(/\/+$/, '');
        this._allowCustomHost = allowCustomHost;

        this._historyStore = options.historyStore || null;
        this._authManager = options.authManager || new AuthManager();
        this._httpTransport = options.httpTransport || null;
        this._configProvider = options.configProvider || getAgyLocalConfig;
        this._nowFn = options.nowFn || Date.now;

        this._soupSession = null;
    }

    /**
     * Executes HTTP request via injected transport or Soup 3.0 session.
     *
     * @param {object} params
     * @param {string} params.url
     * @param {string} [params.method='POST']
     * @param {object} [params.headers={}]
     * @param {string|null} [params.body=null]
     * @returns {Promise<{ status: number, text: string }>}
     */
    async _executeRequest({ url, method = 'POST', headers = {}, body = null }) {
        if (typeof this._httpTransport === 'function') {
            const res = await this._httpTransport({ url, method, headers, body });
            if (res && typeof res.text === 'string' && res.text.length > MAX_RESPONSE_BYTES) {
                throw new Error(`Response size (${res.text.length} bytes) exceeds maximum allowed limit (${MAX_RESPONSE_BYTES} bytes)`);
            }
            return res;
        }

        if (!this._soupSession) {
            this._soupSession = new Soup.Session();
        }

        const message = Soup.Message.new(method, url);
        if (!message) {
            throw new Error(`Failed to create HTTP message for URL: ${url}`);
        }

        for (const [key, value] of Object.entries(headers)) {
            message.request_headers.append(key, value);
        }

        if (body) {
            const bytes = new GLib.Bytes(new TextEncoder().encode(body));
            message.set_request_body_from_bytes(headers['Content-Type'] || 'application/json', bytes);
        }

        return new Promise((resolve, reject) => {
            this._soupSession.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (sess, asyncRes) => {
                    try {
                        const bytes = sess.send_and_read_finish(asyncRes);
                        if (bytes && bytes.get_size() > MAX_RESPONSE_BYTES) {
                            reject(new Error(`Response size (${bytes.get_size()} bytes) exceeds maximum allowed limit (${MAX_RESPONSE_BYTES} bytes)`));
                            return;
                        }
                        const status = message.get_status();
                        const text = bytes ? new TextDecoder('utf-8').decode(bytes.get_data()) : '';
                        if (text.length > MAX_RESPONSE_BYTES) {
                            reject(new Error(`Response size (${text.length} bytes) exceeds maximum allowed limit (${MAX_RESPONSE_BYTES} bytes)`));
                            return;
                        }
                        resolve({ status, text });
                    } catch (err) {
                        reject(err);
                    }
                }
            );
        });
    }

    /**
     * Deduplicates concurrent token refresh calls across parallel API endpoints.
     *
     * @returns {Promise<object|string>}
     */
    async _refreshToken() {
        if (this._tokenRefreshPromise) {
            return this._tokenRefreshPromise;
        }

        this._tokenRefreshPromise = (async () => {
            try {
                if (typeof this._authManager.forceRefreshToken === 'function') {
                    return await this._authManager.forceRefreshToken();
                } else if (typeof this._authManager.getValidToken === 'function') {
                    return await this._authManager.getValidToken({ forceRefresh: true });
                }
                return null;
            } finally {
                this._tokenRefreshPromise = null;
            }
        })();

        return this._tokenRefreshPromise;
    }

    /**
     * Dispatches authenticated POST request, handling automatic 401 token refresh and single retry.
     *
     * @param {string} endpoint - Path suffix (e.g. /v1internal:retrieveUserQuotaSummary)
     * @param {object} bodyObj - Request body object
     * @returns {Promise<object>} Parsed JSON response
     */
    async _postWithAuth(endpoint, bodyObj) {
        const url = `${this._baseUrl}${endpoint}`;
        const bodyJson = JSON.stringify(bodyObj || {});

        let token = await this._authManager.getValidToken();
        const tokenStr = (typeof token === 'object' && token) ? token.accessToken : token;

        const headers = {
            'Authorization': `Bearer ${tokenStr}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity',
        };

        let res = await this._executeRequest({ url, method: 'POST', headers, body: bodyJson });

        if (res && res.status === 401) {
            // 401 Unauthorized: Refresh token and retry exactly once
            const refreshed = await this._refreshToken();
            const retryTokenStr = (typeof refreshed === 'object' && refreshed) ? refreshed.accessToken : refreshed;
            headers['Authorization'] = `Bearer ${retryTokenStr}`;

            res = await this._executeRequest({ url, method: 'POST', headers, body: bodyJson });
            if (res && res.status === 401) {
                throw new Error(`Authentication failed: HTTP 401 Unauthorized after token refresh`);
            }
        }

        if (!res || res.status < 200 || res.status >= 300) {
            const status = res ? res.status : 'Unknown';
            throw new Error(`CloudCode API error: HTTP ${status} for ${endpoint}`);
        }

        try {
            return JSON.parse(res.text);
        } catch (e) {
            throw new Error(`Failed to parse JSON response from ${endpoint}: ${e.message}`);
        }
    }

    /**
     * Fetches current quota summary and model quotas, updates history store, and returns enriched snapshot.
     *
     * @returns {Promise<object>} Complete quota snapshot
     */
    async fetchUsageSnapshot() {
        const cfg = (typeof this._configProvider === 'function')
            ? this._configProvider()
            : (this._configProvider || {});

        const projectId = cfg.projectId || 'default-cli-project';
        const activeModel = cfg.activeModel || cfg.model || 'Gemini 4 Argon (Medium)';
        const nowMs = this._nowFn();

        const [summaryData, modelsData] = await Promise.all([
            this._postWithAuth('/v1internal:retrieveUserQuotaSummary', { project: projectId }),
            this._postWithAuth('/v1internal:fetchAvailableModels', { project: projectId }).catch(() => ({ models: {} })),
        ]);

        const analyzedBuckets = {};
        const groupsResult = {};

        if (summaryData && Array.isArray(summaryData.groups)) {
            for (const group of summaryData.groups) {
                if (!group || typeof group !== 'object') continue;
                const groupKey = (group.displayName && typeof group.displayName === 'string' && group.displayName.toLowerCase().includes('gemini'))
                    ? 'gemini'
                    : '3p';

                const mappedBuckets = [];
                if (Array.isArray(group.buckets)) {
                    for (const b of group.buckets) {
                        if (!b || typeof b !== 'object') continue;
                        const bucketId = typeof b.bucketId === 'string' ? b.bucketId : null;
                        if (!bucketId) continue;
                        const remainingFraction = b.remainingFraction;
                        const resetTime = b.resetTime || null;
                        const window = b.window || (bucketId.includes('5h') ? '5h' : 'weekly');

                        let analyzed = null;
                        if (this._historyStore) {
                            try {
                                this._historyStore.recordSample(bucketId, remainingFraction, resetTime, nowMs);
                                analyzed = this._historyStore.analyzeBucket({
                                    bucketId,
                                    remainingFraction,
                                    resetTimeIso: resetTime,
                                    windowType: window,
                                    nowMs,
                                });
                            } catch (err) {
                                // Keep analyzed null on store error
                            }
                        }

                        if (!analyzed) {
                            const remFrac = Math.max(0, Math.min(1, typeof remainingFraction === 'number' ? remainingFraction : 1));
                            const resetMs = resetTime ? Date.parse(resetTime) : 0;
                            const resetInMs = resetMs > 0 ? Math.max(0, resetMs - nowMs) : 0;
                            analyzed = {
                                bucketId,
                                windowType: window,
                                remainingFraction: remFrac,
                                usedFraction: 1 - remFrac,
                                remainingPercent: remFrac * 100,
                                usedPercent: (1 - remFrac) * 100,
                                resetTimeIso: resetTime,
                                resetInMs,
                                resetInFormatted: formatDuration(resetInMs),
                                burnPercentPerHour: 0,
                                burnPercentPerDay: 0,
                                estimatedDurationMs: null,
                                estimatedDurationFormatted: null,
                                estimatedLabel: 'Seguro até o reset',
                                willExhaustBeforeReset: false,
                                sampleCount: 1,
                            };
                        }

                        analyzedBuckets[bucketId] = analyzed;
                        mappedBuckets.push({
                            ...b,
                            ...analyzed,
                        });
                    }
                }

                groupsResult[groupKey] = {
                    displayName: group.displayName,
                    description: group.description,
                    buckets: mappedBuckets,
                };
            }
        }

        const rawModels = (modelsData && modelsData.models && typeof modelsData.models === 'object')
            ? modelsData.models
            : {};

        let lowestRemainingPercent = 100;
        const familiesResult = [];
        let activeFamilyResult = null;

        for (const fam of AGY_MODEL_FAMILIES) {
            let quotaInfo = null;

            for (const key of fam.apiModelKeys) {
                if (Object.hasOwn(rawModels, key) && rawModels[key] && typeof rawModels[key] === 'object') {
                    quotaInfo = rawModels[key].quotaInfo;
                    break;
                }
            }

            const fallbackBucketKey = `${fam.group}-weekly`;
            const fallbackBucket = analyzedBuckets[fallbackBucketKey] || analyzedBuckets[`${fam.group}-5h`];

            const remainingFraction = (quotaInfo && typeof quotaInfo.remainingFraction === 'number')
                ? quotaInfo.remainingFraction
                : (fallbackBucket ? fallbackBucket.remainingFraction : 1.0);

            const resetTime = (quotaInfo && quotaInfo.resetTime)
                ? quotaInfo.resetTime
                : (fallbackBucket ? fallbackBucket.resetTimeIso : null);

            const remainingPercent = remainingFraction * 100;
            if (remainingPercent < lowestRemainingPercent) {
                lowestRemainingPercent = remainingPercent;
            }

            const isActive = activeModel.toLowerCase().includes(fam.id.replace(/-/g, ' ')) ||
                activeModel.toLowerCase().includes(fam.displayName.toLowerCase()) ||
                (fam.id === 'gemini-4-argon' && activeModel.toLowerCase().includes('argon')) ||
                (fam.id === 'gemini-3.8-flash' && activeModel.toLowerCase().includes('flash')) ||
                (fam.id === 'claude-opus-5-5' && activeModel.toLowerCase().includes('opus')) ||
                (fam.id === 'claude-sonnet-5-5' && activeModel.toLowerCase().includes('sonnet')) ||
                (fam.id === 'gpt-oss-120b' && activeModel.toLowerCase().includes('gpt-oss'));

            const famObj = {
                id: fam.id,
                displayName: fam.displayName,
                group: fam.group,
                defaultTier: fam.defaultTier,
                remainingFraction,
                remainingPercent,
                resetTime,
                isActive,
                bucket: fallbackBucket || null,
            };

            if (isActive && !activeFamilyResult) {
                activeFamilyResult = famObj;
            }

            familiesResult.push(famObj);
        }

        if (!activeFamilyResult && familiesResult.length > 0) {
            activeFamilyResult = familiesResult[0];
            activeFamilyResult.isActive = true;
        }

        return {
            timestamp: nowMs,
            projectId,
            activeModel,
            activeFamily: activeFamilyResult,
            lowestRemainingPercent,
            groups: groupsResult,
            buckets: analyzedBuckets,
            families: familiesResult,
            models: rawModels,
        };
    }

    /**
     * Alias for fetchUsageSnapshot.
     *
     * @returns {Promise<object>}
     */
    fetchAllQuotaData() {
        return this.fetchUsageSnapshot();
    }

    /**
     * Releases active Soup session resources.
     */
    destroy() {
        if (this._soupSession) {
            try {
                this._soupSession.abort();
            } catch (e) {
                // Ignore abort error
            }
            this._soupSession = null;
        }
    }
}
