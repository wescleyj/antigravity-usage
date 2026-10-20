export const tests = [];

export function test(name, fn) {
    tests.push({ name, fn });
}

export function assertEqual(actual, expected, msg = '') {
    if (actual !== expected) {
        if (typeof actual === 'object' && typeof expected === 'object' && actual !== null && expected !== null) {
            if (JSON.stringify(actual) === JSON.stringify(expected)) {
                return;
            }
        }
        const errorMsg = msg ? `${msg}: ` : '';
        throw new Error(`${errorMsg}Expected ${JSON.stringify(expected)}, but got ${JSON.stringify(actual)}`);
    }
}

export function assertAlmostEqual(actual, expected, epsilon = 1e-6, msg = '') {
    if (Math.abs(actual - expected) > epsilon) {
        const errorMsg = msg ? `${msg}: ` : '';
        throw new Error(`${errorMsg}Expected ${actual} to be within ${epsilon} of ${expected}`);
    }
}

export function assertTrue(val, msg = '') {
    if (!val) {
        const errorMsg = msg ? `${msg}: ` : '';
        throw new Error(`${errorMsg}Expected truthy value, but got ${val}`);
    }
}

export function assertThrows(fn, msg = '') {
    let threw = false;
    try {
        fn();
    } catch (e) {
        threw = true;
    }
    if (!threw) {
        const errorMsg = msg ? `${msg}: ` : '';
        throw new Error(`${errorMsg}Expected function to throw an error, but it did not`);
    }
}
