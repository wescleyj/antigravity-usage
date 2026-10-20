import GLib from 'gi://GLib';
import {
    test,
    assertEqual,
    assertAlmostEqual,
    assertTrue,
    assertThrows,
} from './assert.js';
import {
    parseNanoIsoDate,
    isTokenExpired,
    getKeyringAuthToken,
    refreshTokenViaAgyCli,
    AuthManager,
} from '../src/lib/auth.js';
import {
    AGY_MODEL_FAMILIES,
    ALLOWED_API_HOSTS,
    MAX_RESPONSE_BYTES,
    AntigravityQuotaClient,
} from '../src/lib/api.js';
import { UsageHistoryStore } from '../src/lib/history.js';

function getTempTestFile() {
    const tmpDir = GLib.build_filenamev([GLib.get_tmp_dir(), 'api-test-' + Math.random().toString(36).substring(2)]);
    return GLib.build_filenamev([tmpDir, 'history.json']);
}

// -------------------------------------------------------------------------
// parseNanoIsoDate tests
// -------------------------------------------------------------------------
test('parseNanoIsoDate: truncates Go RFC3339Nano 9 digits to 3 digits and parses ms', () => {
    // 2026-10-20T13:05:54.543148388-03:00 -> ms part should be 543
    const nanoDate = '2026-10-20T13:05:54.543148388-03:00';
    const parsed = parseNanoIsoDate(nanoDate);
    assertTrue(typeof parsed === 'number' && Number.isFinite(parsed), 'returns finite number');

    const expected = Date.parse('2026-10-20T13:05:54.543-03:00');
    assertEqual(parsed, expected, 'nanoseconds truncated to milliseconds');

    // Standard ISO without extra nanoseconds
    const standardDate = '2026-10-22T01:17:49.123Z';
    assertEqual(parseNanoIsoDate(standardDate), Date.parse(standardDate), 'standard 3ms parsed');

    // Without milliseconds
    const noMsDate = '2026-10-22T01:17:49Z';
    assertEqual(parseNanoIsoDate(noMsDate), Date.parse(noMsDate), 'no ms parsed');

    // Invalid / empty inputs
    assertEqual(parseNanoIsoDate(null), null, 'null returns null');
    assertEqual(parseNanoIsoDate(''), null, 'empty returns null');
    assertEqual(parseNanoIsoDate('INVALID_DATE'), null, 'invalid date returns null');
});

// -------------------------------------------------------------------------
// isTokenExpired tests
// -------------------------------------------------------------------------
test('isTokenExpired: checks token expiration with 60s buffer', () => {
    const now = 1700000000000;

    // Token valid for 120s (> 60s buffer) -> not expired
    const validToken = { accessToken: 'ya29.test', expiryMs: now + 120 * 1000 };
    assertEqual(isTokenExpired(validToken, 60, now), false, 'token with 120s left is valid');

    // Token with 50s left (<= 60s buffer) -> considered expired
    const expiringSoonToken = { accessToken: 'ya29.test', expiryMs: now + 50 * 1000 };
    assertEqual(isTokenExpired(expiringSoonToken, 60, now), true, 'token with 50s left is expired (buffer)');

    // Token with exact 60s left -> considered expired
    const exactBufferToken = { accessToken: 'ya29.test', expiryMs: now + 60 * 1000 };
    assertEqual(isTokenExpired(exactBufferToken, 60, now), true, 'token with exact 60s left is expired');

    // Token in the past -> expired
    const expiredToken = { accessToken: 'ya29.test', expiryMs: now - 1000 };
    assertEqual(isTokenExpired(expiredToken, 60, now), true, 'past token is expired');

    // Missing token or expiry
    assertEqual(isTokenExpired(null, 60, now), true, 'null token is expired');
    assertEqual(isTokenExpired({}, 60, now), true, 'empty token is expired');
    assertEqual(isTokenExpired({ accessToken: 'ya29.test' }, 60, now), true, 'missing expiry is expired');
});

// -------------------------------------------------------------------------
// getKeyringAuthToken tests
// -------------------------------------------------------------------------
test('getKeyringAuthToken: retrieves token without leaking secret in error messages', () => {
    const validSecret = JSON.stringify({
        token: {
            access_token: 'ya29.secret_test_token',
            token_type: 'Bearer',
            refresh_token: '1//refresh_token',
            expiry: '2026-10-20T13:05:54.543148388-03:00',
        },
        auth_method: 'consumer',
    });

    // 1. Success with injected lookup
    const token = getKeyringAuthToken(() => validSecret);
    assertEqual(token.accessToken, 'ya29.secret_test_token', 'accessToken extracted');
    assertTrue(typeof token.expiryMs === 'number', 'expiryMs extracted');
    assertEqual(token.tokenType, 'Bearer', 'tokenType extracted');

    // 2. Secret not found throws clean error
    let notFoundError;
    try {
        getKeyringAuthToken(() => null);
    } catch (e) {
        notFoundError = e;
    }
    assertTrue(notFoundError !== undefined, 'throws when secret is null');
    assertTrue(!notFoundError.message.includes('ya29'), 'no token leakage in message');

    // 3. Corrupt JSON throws clean error
    let corruptError;
    try {
        getKeyringAuthToken(() => 'NOT_VALID_JSON{');
    } catch (e) {
        corruptError = e;
    }
    assertTrue(corruptError !== undefined, 'throws on corrupt JSON');

    // 4. Missing access_token
    let missingTokenError;
    try {
        getKeyringAuthToken(() => JSON.stringify({ token: {} }));
    } catch (e) {
        missingTokenError = e;
    }
    assertTrue(missingTokenError !== undefined, 'throws when access_token missing');
});

// -------------------------------------------------------------------------
// refreshTokenViaAgyCli & AuthManager tests
// -------------------------------------------------------------------------
test('refreshTokenViaAgyCli: executes fixed args agy models without shell', async () => {
    let capturedArgs = null;
    const mockRunner = async (argv) => {
        capturedArgs = argv;
        return true;
    };

    await refreshTokenViaAgyCli(mockRunner);
    assertTrue(Array.isArray(capturedArgs), 'argv must be array');
    assertEqual(capturedArgs[capturedArgs.length - 1], 'models', 'subcommand is models');
});

test('AuthManager: caches token and coordinates concurrent refresh with mutex', async () => {
    let lookupCount = 0;
    let runnerCount = 0;
    let tokenExpiry = 1700000000000 + 3600 * 1000;

    const secretLookupFn = () => {
        lookupCount++;
        return JSON.stringify({
            token: {
                access_token: `token_v${lookupCount}`,
                expiry: new Date(tokenExpiry).toISOString(),
            },
        });
    };

    let releaseRunner;
    const subprocessRunnerFn = () => {
        runnerCount++;
        return new Promise(res => { releaseRunner = res; });
    };

    const auth = new AuthManager({
        secretLookupFn,
        subprocessRunnerFn,
        nowFn: () => 1700000000000,
    });

    // 1. First getValidToken reads from keyring without CLI refresh
    const t1 = await auth.getValidToken();
    assertEqual(t1, 'token_v1', 'initial token from keyring');
    assertEqual(lookupCount, 1, '1 lookup');
    assertEqual(runnerCount, 0, '0 CLI runs');

    // 2. Second getValidToken uses cached token
    const t2 = await auth.getValidToken();
    assertEqual(t2, 'token_v1', 'cached token returned');
    assertEqual(lookupCount, 1, 'no extra lookup');

    // 3. Force refresh with multiple concurrent callers: only 1 CLI execution occurs
    tokenExpiry = 1700000000000 + 7200 * 1000;
    const p1 = auth.getValidToken({ forceRefresh: true });
    const p2 = auth.getValidToken({ forceRefresh: true });
    const p3 = auth.forceRefreshToken();

    assertEqual(runnerCount, 1, 'exactly 1 runner started for concurrent requests');

    releaseRunner();
    const [res1, res2, res3] = await Promise.all([p1, p2, p3]);

    assertEqual(res1, 'token_v2', 'refreshed token returned to p1');
    assertEqual(res2, 'token_v2', 'refreshed token returned to p2');
    assertEqual(res3.accessToken, 'token_v2', 'refreshed token returned to p3');
    assertEqual(runnerCount, 1, 'runner executed exactly once');
    assertEqual(lookupCount, 2, 'lookup reloaded after refresh');
});

// -------------------------------------------------------------------------
// AGY_MODEL_FAMILIES structure & deep freeze tests
// -------------------------------------------------------------------------
test('AGY_MODEL_FAMILIES: deep freeze and model family coverage', () => {
    assertTrue(Array.isArray(AGY_MODEL_FAMILIES), 'is array');
    assertTrue(Object.isFrozen(AGY_MODEL_FAMILIES), 'outer array is frozen');

    const familyIds = AGY_MODEL_FAMILIES.map(f => f.id);
    assertEqual(
        familyIds,
        ['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b'],
        'contains 5 canonical families'
    );

    for (const fam of AGY_MODEL_FAMILIES) {
        assertTrue(Object.isFrozen(fam), `family ${fam.id} is frozen`);
        assertTrue(Array.isArray(fam.apiModelKeys), `apiModelKeys is array for ${fam.id}`);
        assertTrue(Object.isFrozen(fam.apiModelKeys), `apiModelKeys is frozen for ${fam.id}`);
    }
});

// -------------------------------------------------------------------------
// AntigravityQuotaClient tests
// -------------------------------------------------------------------------
test('AntigravityQuotaClient: enforces HTTPS on baseUrl', () => {
    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'http://insecure.api.com' });
    }, 'http URL rejected');

    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'ftp://cloudcode.com' });
    }, 'non-http URL rejected');

    // Default HTTPS allowed
    const client = new AntigravityQuotaClient();
    assertEqual(client._baseUrl, 'https://cloudcode-pa.googleapis.com', 'default https URL accepted');
});

test('AntigravityQuotaClient: fetches usage snapshot, records history, and maps families', async () => {
    const testFile = getTempTestFile();
    const historyStore = new UsageHistoryStore(testFile);
    const now = 1700000000000;

    const mockQuotaSummary = {
        groups: [
            {
                displayName: 'Gemini Models',
                description: 'Models within this group: Gemini Flash, Gemini Pro',
                buckets: [
                    {
                        bucketId: 'gemini-weekly',
                        displayName: 'Weekly Limit Remaining',
                        window: 'weekly',
                        resetTime: '2026-10-22T01:17:49Z',
                        remainingFraction: 0.85,
                    },
                    {
                        bucketId: 'gemini-5h',
                        displayName: 'Five Hour Limit Remaining',
                        window: '5h',
                        resetTime: '2026-10-20T20:19:41Z',
                        remainingFraction: 1.0,
                    },
                ],
            },
            {
                displayName: 'Claude and GPT models',
                description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
                buckets: [
                    {
                        bucketId: '3p-weekly',
                        displayName: 'Weekly Limit Remaining',
                        window: 'weekly',
                        resetTime: '2026-10-22T22:50:24Z',
                        remainingFraction: 0.40,
                    },
                    {
                        bucketId: '3p-5h',
                        displayName: 'Five Hour Limit Remaining',
                        window: '5h',
                        resetTime: '2026-10-20T20:19:41Z',
                        remainingFraction: 0.90,
                    },
                ],
            },
        ],
    };

    const mockAvailableModels = {
        models: {
            'claude-opus-5-5-medium': {
                displayName: 'Claude Opus 5.5 (Medium)',
                quotaInfo: {
                    remainingFraction: 0.40,
                    resetTime: '2026-10-22T22:50:24Z',
                },
            },
            'gemini-4-argon-medium': {
                displayName: 'Gemini 4 Argon (Medium)',
                quotaInfo: {
                    remainingFraction: 0.85,
                    resetTime: '2026-10-22T01:17:49Z',
                },
            },
        },
    };

    const httpTransport = async ({ url, method, headers, body }) => {
        assertEqual(headers['Authorization'], 'Bearer mock_token', 'Authorization header matches');
        assertEqual(headers['Content-Type'], 'application/json', 'Content-Type matches');
        assertEqual(headers['User-Agent'], 'antigravity', 'User-Agent matches');

        if (url.includes(':retrieveUserQuotaSummary')) {
            return { status: 200, text: JSON.stringify(mockQuotaSummary) };
        }
        if (url.includes(':fetchAvailableModels')) {
            return { status: 200, text: JSON.stringify(mockAvailableModels) };
        }
        throw new Error(`Unexpected URL: ${url}`);
    };

    const authManager = {
        getValidToken: async () => 'mock_token',
        forceRefreshToken: async () => 'mock_token_refreshed',
    };

    const client = new AntigravityQuotaClient({
        historyStore,
        authManager,
        httpTransport,
        configProvider: () => ({ activeModel: 'Gemini 4 Argon (Medium)', projectId: 'test-project' }),
        nowFn: () => now,
    });

    const snapshot = await client.fetchUsageSnapshot();

    assertEqual(snapshot.projectId, 'test-project', 'snapshot has projectId');
    assertEqual(snapshot.activeModel, 'Gemini 4 Argon (Medium)', 'activeModel preserved');
    assertEqual(snapshot.activeFamily.id, 'gemini-4-argon', 'gemini-4-argon is active family');
    assertAlmostEqual(snapshot.lowestRemainingPercent, 40.0, 1e-2, 'lowestRemainingPercent is 40%');

    // Check buckets analyzed in historyStore
    assertTrue('gemini-weekly' in snapshot.buckets, 'has gemini-weekly bucket');
    assertEqual(snapshot.buckets['gemini-weekly'].sampleCount, 1, 'sample recorded in store');
    assertAlmostEqual(snapshot.buckets['gemini-weekly'].remainingFraction, 0.85, 1e-3, 'fraction matches');

    // Verify alias fetchAllQuotaData returns same format
    const aliasSnapshot = await client.fetchAllQuotaData();
    assertEqual(aliasSnapshot.projectId, snapshot.projectId, 'alias matches');
});

test('AntigravityQuotaClient: handles HTTP 401 with automatic token refresh and single retry', async () => {
    let refreshCount = 0;
    let requestCount = 0;

    const authManager = {
        getValidToken: async () => 'initial_token',
        forceRefreshToken: async () => {
            refreshCount++;
            return 'refreshed_token';
        },
    };

    const httpTransport = async ({ url, headers }) => {
        requestCount++;
        if (headers['Authorization'] === 'Bearer initial_token') {
            return { status: 401, text: 'Unauthorized' };
        }
        return {
            status: 200,
            text: JSON.stringify({ groups: [] }),
        };
    };

    const client = new AntigravityQuotaClient({
        authManager,
        httpTransport,
    });

    const snapshot = await client.fetchUsageSnapshot();
    assertEqual(refreshCount, 1, 'triggered forceRefreshToken once');
    assertTrue(requestCount >= 2, 'retried after 401');
    assertTrue(snapshot !== undefined, 'snapshot returned after successful retry');
});

test('AntigravityQuotaClient: fails gracefully if 401 persists after refresh', async () => {
    let refreshCount = 0;

    const authManager = {
        getValidToken: async () => 'token',
        forceRefreshToken: async () => {
            refreshCount++;
            return 'new_token';
        },
    };

    const httpTransport = async () => {
        return { status: 401, text: 'Persistent Unauthorized' };
    };

    const client = new AntigravityQuotaClient({
        authManager,
        httpTransport,
    });

    let threw = false;
    try {
        await client.fetchUsageSnapshot();
    } catch (err) {
        threw = true;
    }

    assertTrue(threw, 'throws when 401 persists after retry');
    assertEqual(refreshCount, 1, 'did not loop infinitely on 401');
});

// -------------------------------------------------------------------------
// QA Edge Cases
// -------------------------------------------------------------------------
test('QA Edge Case: parseNanoIsoDate handles nanosecond precision variations and malformed strings', () => {
    // 0 fractional digits
    const d0 = parseNanoIsoDate('2026-10-20T13:05:54Z');
    assertEqual(d0, Date.parse('2026-10-20T13:05:54Z'), '0 digits parsed');

    // 1 fractional digit (.1 -> 100ms)
    const d1 = parseNanoIsoDate('2026-10-20T13:05:54.1Z');
    assertEqual(d1, Date.parse('2026-10-20T13:05:54.1Z'), '1 digit parsed');

    // 3 fractional digits (.123 -> 123ms)
    const d3 = parseNanoIsoDate('2026-10-20T13:05:54.123Z');
    assertEqual(d3, Date.parse('2026-10-20T13:05:54.123Z'), '3 digits parsed');

    // 6 fractional digits (.123456 -> truncated to .123)
    const d6 = parseNanoIsoDate('2026-10-20T13:05:54.123456Z');
    assertEqual(d6, Date.parse('2026-10-20T13:05:54.123Z'), '6 digits truncated to 3');

    // 9 fractional digits (.123456789 -> truncated to .123)
    const d9 = parseNanoIsoDate('2026-10-20T13:05:54.123456789Z');
    assertEqual(d9, Date.parse('2026-10-20T13:05:54.123Z'), '9 digits truncated to 3');

    // Non-string types
    assertEqual(parseNanoIsoDate(12345), null, 'number returns null');
    assertEqual(parseNanoIsoDate({}), null, 'object returns null');
    assertEqual(parseNanoIsoDate([]), null, 'array returns null');
    assertEqual(parseNanoIsoDate(undefined), null, 'undefined returns null');
    assertEqual(parseNanoIsoDate('not-a-valid-date'), null, 'garbage string returns null');
});

test('QA Edge Case: isTokenExpired handles boundary buffer values and non-finite timestamps', () => {
    const now = 1700000000000;
    const token = { accessToken: 'ya29.valid', expiryMs: now + 60000 };

    // Exact buffer boundary
    assertEqual(isTokenExpired(token, 60, now), true, 'boundary 60s matches <= bufferMs');
    assertEqual(isTokenExpired(token, 59, now), false, 'boundary 59s is valid');

    // Buffer 0 seconds
    const exactNowToken = { accessToken: 'ya29.valid', expiryMs: now };
    assertEqual(isTokenExpired(exactNowToken, 0, now), true, '0 buffer at exact now is expired');

    // Non-numeric bufferSec falls back to 60s default
    assertEqual(isTokenExpired(token, NaN, now), true, 'NaN bufferSec defaults to 60s');
    assertEqual(isTokenExpired(token, null, now), true, 'null bufferSec defaults to 60s');

    // Whitespace or empty accessToken
    assertEqual(isTokenExpired({ accessToken: '   ', expiryMs: now + 100000 }, 60, now), true, 'whitespace accessToken expired');
    assertEqual(isTokenExpired({ accessToken: '', expiryMs: now + 100000 }, 60, now), true, 'empty accessToken expired');

    // NaN / Infinity expiryMs
    assertEqual(isTokenExpired({ accessToken: 'ya29.valid', expiryMs: NaN }, 60, now), true, 'NaN expiryMs is expired');
    assertEqual(isTokenExpired({ accessToken: 'ya29.valid', expiryMs: Infinity }, 60, now), true, 'Infinity expiryMs is expired');
});

test('QA Edge Case: getKeyringAuthToken handles root and nested token shapes, whitespace tokens and array payloads', () => {
    // Top-level access_token
    const rootSecret = JSON.stringify({
        access_token: 'ya29.root_token',
        expiry: '2026-10-22T01:17:49Z',
    });
    const rootRes = getKeyringAuthToken(() => rootSecret);
    assertEqual(rootRes.accessToken, 'ya29.root_token', 'root access_token parsed');

    // Nested camelCase accessToken
    const nestedCamelSecret = JSON.stringify({
        token: {
            accessToken: 'ya29.camel_token',
            expiryTime: '2026-10-22T01:17:49Z',
        },
    });
    const camelRes = getKeyringAuthToken(() => nestedCamelSecret);
    assertEqual(camelRes.accessToken, 'ya29.camel_token', 'nested camelCase parsed');

    // Whitespace-only accessToken throws
    assertThrows(() => {
        getKeyringAuthToken(() => JSON.stringify({ access_token: '   ' }));
    }, 'whitespace token rejected');

    // Array payload throws
    assertThrows(() => {
        getKeyringAuthToken(() => JSON.stringify([{ access_token: 'ya29.array' }]));
    }, 'array payload rejected');

    // secretLookupFn throws unexpected exception
    assertThrows(() => {
        getKeyringAuthToken(() => { throw new Error('DBus communication failure'); });
    }, 'lookup exception caught');
});

test('QA Edge Case: AntigravityQuotaClient handles empty groups, null bucket items, and malformed models responses', async () => {
    const authManager = {
        getValidToken: async () => 'test_token',
    };

    const httpTransport = async ({ url }) => {
        if (url.includes(':retrieveUserQuotaSummary')) {
            return {
                status: 200,
                text: JSON.stringify({
                    groups: [
                        null, // null group in array
                        {
                            displayName: 'Gemini Group',
                            buckets: [
                                null, // null bucket
                                { bucketId: null }, // missing bucketId
                                { bucketId: 'gemini-5h', remainingFraction: 0.75, resetTime: '2026-10-20T20:00:00Z' },
                            ],
                        },
                    ],
                }),
            };
        }
        if (url.includes(':fetchAvailableModels')) {
            return {
                status: 200,
                text: JSON.stringify({
                    models: null, // null models
                }),
            };
        }
        throw new Error('Unknown URL');
    };

    const client = new AntigravityQuotaClient({
        baseUrl: 'https://cloudcode-pa.googleapis.com/', // Trailing slash
        authManager,
        httpTransport,
    });

    assertEqual(client._baseUrl, 'https://cloudcode-pa.googleapis.com', 'trailing slash trimmed');

    const snapshot = await client.fetchUsageSnapshot();
    assertTrue(snapshot !== undefined, 'snapshot returned safely');
    assertTrue('gemini' in snapshot.groups, 'gemini group exists');
    assertEqual(snapshot.groups.gemini.buckets.length, 1, 'only valid bucket mapped');
    assertAlmostEqual(snapshot.groups.gemini.buckets[0].remainingFraction, 0.75, 1e-2, 'valid bucket parsed');
});

// -------------------------------------------------------------------------
// Security Audits (SEC-API)
// -------------------------------------------------------------------------
test('SEC-API-01: Zero secret token leakage in exception messages', async () => {
    const secretValue = 'ya29.SUPER_CONFIDENTIAL_OAUTH_TOKEN_VALUE';

    // 1. Corrupted JSON containing secret fragment
    try {
        getKeyringAuthToken(() => `{ "access_token": "${secretValue}" INVALID`);
    } catch (err) {
        assertTrue(!err.message.includes(secretValue), 'Keyring JSON error does not leak secret');
    }

    // 2. HTTP transport throwing with token
    const client = new AntigravityQuotaClient({
        authManager: { getValidToken: async () => secretValue },
        httpTransport: async () => {
            return { status: 401, text: 'Unauthorized' };
        },
    });

    try {
        await client.fetchUsageSnapshot();
    } catch (err) {
        assertTrue(!err.message.includes(secretValue), 'HTTP 401 error does not leak token');
    }
});

test('SEC-API-02: Base URL scheme security enforcement', () => {
    // Rejects cleartext HTTP
    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'http://cloudcode.googleapis.com' });
    }, 'http rejected');

    // Rejects FTP
    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'ftp://cloudcode.googleapis.com' });
    }, 'ftp rejected');

    // Rejects javascript pseudo-protocol
    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'javascript:alert(1)' });
    }, 'javascript rejected');

    // Rejects relative paths
    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: '/v1internal:retrieveUserQuotaSummary' });
    }, 'relative URL rejected');

    // Rejects empty / non-string
    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: '' });
    }, 'empty baseUrl rejected');
});

test('SEC-API-03: Subprocess argument isolation', async () => {
    let capturedArgv = null;
    const runner = async (argv) => {
        capturedArgv = argv;
        return true;
    };

    await refreshTokenViaAgyCli(runner);

    assertTrue(Array.isArray(capturedArgv), 'runner receives fixed array');
    assertEqual(capturedArgv.length, 2, 'contains exactly 2 elements (bin and subcommand)');
    assertEqual(capturedArgv[0], 'agy', 'binary name is agy');
    assertEqual(capturedArgv[1], 'models', 'subcommand is models');
});

test('SEC-API-04: Immutability of canonical AGY_MODEL_FAMILIES', () => {
    assertTrue(Object.isFrozen(AGY_MODEL_FAMILIES), 'AGY_MODEL_FAMILIES is frozen');

    // Attempt mutation
    try {
        AGY_MODEL_FAMILIES.push({ id: 'injected-family' });
    } catch (e) {
        // TypeError expected in strict mode
    }
    assertEqual(AGY_MODEL_FAMILIES.length, 5, 'length unchanged');

    for (const fam of AGY_MODEL_FAMILIES) {
        assertTrue(Object.isFrozen(fam), `family ${fam.id} is frozen`);
        assertTrue(Object.isFrozen(fam.apiModelKeys), `apiModelKeys of ${fam.id} is frozen`);
    }
});

// -------------------------------------------------------------------------
// QA Edge-Case & Robustness Tests (Issue #4 Acceptance Criteria)
// -------------------------------------------------------------------------
test('QA Edge Case: AntigravityQuotaClient handles HTTP 500 and 503 errors on quota summary', async () => {
    // 1. HTTP 500
    const client500 = new AntigravityQuotaClient({
        authManager: { getValidToken: async () => 'mock_token' },
        httpTransport: async () => ({ status: 500, text: 'Internal Server Error' }),
    });

    let threw500 = false;
    try {
        await client500.fetchUsageSnapshot();
    } catch (err) {
        threw500 = true;
        assertTrue(err.message.includes('500'), 'error message mentions HTTP 500');
        assertTrue(!err.message.includes('mock_token'), 'token is not leaked in error');
    }
    assertTrue(threw500, 'throws on HTTP 500');

    // 2. HTTP 503
    const client503 = new AntigravityQuotaClient({
        authManager: { getValidToken: async () => 'mock_token' },
        httpTransport: async () => ({ status: 503, text: 'Service Unavailable' }),
    });

    let threw503 = false;
    try {
        await client503.fetchUsageSnapshot();
    } catch (err) {
        threw503 = true;
        assertTrue(err.message.includes('503'), 'error message mentions HTTP 503');
    }
    assertTrue(threw503, 'throws on HTTP 503');
});

test('QA Edge Case: AntigravityQuotaClient resilient when fetchAvailableModels endpoint fails with 500', async () => {
    const clientModels500 = new AntigravityQuotaClient({
        authManager: { getValidToken: async () => 'mock_token' },
        httpTransport: async ({ url }) => {
            if (url.includes(':retrieveUserQuotaSummary')) {
                return {
                    status: 200,
                    text: JSON.stringify({
                        groups: [
                            {
                                displayName: 'Gemini Models',
                                buckets: [
                                    { bucketId: 'gemini-weekly', remainingFraction: 0.9, resetTime: '2026-10-22T00:00:00Z' },
                                ],
                            },
                        ],
                    }),
                };
            }
            // Models endpoint fails with 500
            return { status: 500, text: 'Internal Server Error in fetchAvailableModels' };
        },
    });

    const snapshot = await clientModels500.fetchUsageSnapshot();
    assertTrue(snapshot !== undefined, 'snapshot returned despite models 500');
    assertTrue('gemini' in snapshot.groups, 'group buckets mapped');
    assertEqual(snapshot.activeFamily.id, 'gemini-4-argon', 'active family resolved');
});

test('QA Edge Case: AntigravityQuotaClient handles malformed JSON responses cleanly without leaking tokens', async () => {
    const clientMalformed = new AntigravityQuotaClient({
        authManager: { getValidToken: async () => 'mock_token' },
        httpTransport: async () => ({ status: 200, text: '<html><head><title>Bad Gateway</title></head><body>502</body></html>' }),
    });

    let threw = false;
    try {
        await clientMalformed.fetchUsageSnapshot();
    } catch (err) {
        threw = true;
        assertTrue(err.message.includes('parse JSON'), 'clean parse JSON error message');
        assertTrue(!err.message.includes('mock_token'), 'token is not leaked in parse error');
    }
    assertTrue(threw, 'throws on HTML/malformed JSON body');
});

test('QA Edge Case: AuthManager handles refreshTokenViaAgyCli process failure and clears mutex', async () => {
    let runnerCalled = 0;
    const failingRunner = async () => {
        runnerCalled++;
        throw new Error('agy CLI process failed with code 1');
    };

    const auth = new AuthManager({
        secretLookupFn: () => JSON.stringify({ token: { access_token: 'expired_token', expiry: '2020-01-01T00:00:00Z' } }),
        subprocessRunnerFn: failingRunner,
    });

    let threw = false;
    try {
        await auth.getValidToken();
    } catch (err) {
        threw = true;
        assertTrue(err.message.includes('agy CLI process failed'), 'error propagates');
    }
    assertTrue(threw, 'throws on CLI failure');
    assertEqual(runnerCalled, 1, 'runner was invoked');

    // Mutex promise must be cleared in finally
    assertEqual(auth._refreshPromise, null, '_refreshPromise cleared in finally allowing future retry');
});

test('QA Edge Case: AntigravityQuotaClient accurately matches all activeModel variations', async () => {
    const variations = [
        { model: 'Gemini 4 Argon (High)', expectedFamily: 'gemini-4-argon' },
        { model: 'Gemini 4 Argon (Low)', expectedFamily: 'gemini-4-argon' },
        { model: 'gemini-4-argon-medium', expectedFamily: 'gemini-4-argon' },
        { model: 'Argon', expectedFamily: 'gemini-4-argon' },
        { model: 'Gemini 3.8 Flash (Tiered)', expectedFamily: 'gemini-3.8-flash' },
        { model: 'gemini-3.8-flash', expectedFamily: 'gemini-3.8-flash' },
        { model: 'Flash', expectedFamily: 'gemini-3.8-flash' },
        { model: 'Claude Opus 5.5 (Low)', expectedFamily: 'claude-opus-5-5' },
        { model: 'Claude Opus 5.5 (High)', expectedFamily: 'claude-opus-5-5' },
        { model: 'Opus', expectedFamily: 'claude-opus-5-5' },
        { model: 'Claude Sonnet 5.5 (Low)', expectedFamily: 'claude-sonnet-5-5' },
        { model: 'Claude Sonnet 5.5 (High)', expectedFamily: 'claude-sonnet-5-5' },
        { model: 'Sonnet', expectedFamily: 'claude-sonnet-5-5' },
        { model: 'GPT-OSS 120B (Standard)', expectedFamily: 'gpt-oss-120b' },
        { model: 'gpt-oss', expectedFamily: 'gpt-oss-120b' },
        { model: 'Some Unknown Future Model', expectedFamily: 'gemini-4-argon' }, // fallback
    ];

    for (const v of variations) {
        const client = new AntigravityQuotaClient({
            authManager: { getValidToken: async () => 'mock_token' },
            httpTransport: async () => ({ status: 200, text: JSON.stringify({ groups: [] }) }),
            configProvider: () => ({ activeModel: v.model, projectId: 'test-project' }),
        });
        const snap = await client.fetchUsageSnapshot();
        assertEqual(
            snap.activeFamily.id,
            v.expectedFamily,
            `Model string "${v.model}" must match family "${v.expectedFamily}"`
        );
    }
});

test('QA Edge Case: AntigravityQuotaClient destroy() safely aborts active SoupSession', () => {
    const client = new AntigravityQuotaClient();
    client.destroy();
    assertEqual(client._soupSession, null, 'soupSession is null after destroy()');

    // Calling destroy multiple times is safe
    client.destroy();
    assertEqual(client._soupSession, null, 'repeated destroy() is safe');
});

// -------------------------------------------------------------------------
// Security Hardening (SEC-API-01, SEC-API-02, SEC-API-03 Hardening)
// -------------------------------------------------------------------------
test('SEC-API-01: Base URL host whitelist validation rejects unauthorized external hosts (SSRF prevention)', () => {
    assertTrue(ALLOWED_API_HOSTS instanceof Set, 'ALLOWED_API_HOSTS is a Set');
    assertTrue(Object.isFrozen(ALLOWED_API_HOSTS), 'ALLOWED_API_HOSTS is frozen');
    assertTrue(ALLOWED_API_HOSTS.has('cloudcode-pa.googleapis.com'), 'has production host');
    assertTrue(ALLOWED_API_HOSTS.has('daily-cloudcode-pa.googleapis.com'), 'has daily staging host');

    // 1. Unauthorized external host throws whitelist error
    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'https://evil.com' });
    }, 'evil.com rejected');

    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'https://attacker.org/exfiltrate' });
    }, 'attacker.org rejected');

    assertThrows(() => {
        new AntigravityQuotaClient({ baseUrl: 'https://googleapis.com.evil.com' });
    }, 'subdomain spoofing rejected');

    // 2. Whitelisted hosts accepted
    const prodClient = new AntigravityQuotaClient({ baseUrl: 'https://cloudcode-pa.googleapis.com' });
    assertEqual(prodClient._baseUrl, 'https://cloudcode-pa.googleapis.com', 'prod host accepted');

    const dailyClient = new AntigravityQuotaClient({ baseUrl: 'https://daily-cloudcode-pa.googleapis.com' });
    assertEqual(dailyClient._baseUrl, 'https://daily-cloudcode-pa.googleapis.com', 'daily host accepted');

    // 3. allowCustomHost = true explicitly permits custom host for testing
    const customClient = new AntigravityQuotaClient({
        baseUrl: 'https://mock-internal-api.test',
        allowCustomHost: true,
    });
    assertEqual(customClient._baseUrl, 'https://mock-internal-api.test', 'custom host permitted with allowCustomHost');
});

test('SEC-API-02: Response payload size limit (MAX_RESPONSE_BYTES = 5MB) prevents DoS/OOM', async () => {
    assertEqual(MAX_RESPONSE_BYTES, 5 * 1024 * 1024, 'MAX_RESPONSE_BYTES is 5 MB');

    // Injected transport returns payload exceeding MAX_RESPONSE_BYTES
    const oversizedText = 'A'.repeat(MAX_RESPONSE_BYTES + 10);
    const clientOversized = new AntigravityQuotaClient({
        authManager: { getValidToken: async () => 'mock_token' },
        httpTransport: async () => ({ status: 200, text: oversizedText }),
    });

    let threw = false;
    try {
        await clientOversized.fetchUsageSnapshot();
    } catch (err) {
        threw = true;
        assertTrue(err.message.includes('exceeds maximum allowed limit'), 'error mentions limit exceeded');
    }
    assertTrue(threw, 'throws when response payload exceeds 5MB');
});

test('SEC-API-03: Subprocess runner validates binary IS_EXECUTABLE before launching Gio.Subprocess', async () => {
    // Calling refreshTokenViaAgyCli() without mock runner in test env where agy is not installed or not executable
    let threw = false;
    try {
        await refreshTokenViaAgyCli();
    } catch (err) {
        threw = true;
        assertTrue(err.message.includes('not found or not executable'), 'clean error when binary is not executable');
    }
    assertTrue(threw, 'throws when agy binary is not executable');
});

