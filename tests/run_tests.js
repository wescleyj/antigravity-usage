import system from 'system';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { tests } from './assert.js';

async function main() {
    const currentFile = Gio.File.new_for_uri(import.meta.url);
    const testsDir = currentFile.get_parent();

    const enumerator = testsDir.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NONE,
        null
    );

    const testFiles = [];
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (name.endsWith('.test.js')) {
            const childFile = testsDir.get_child(name);
            testFiles.push(childFile.get_path());
        }
    }
    enumerator.close(null);

    testFiles.sort();

    for (const filePath of testFiles) {
        await import(`file://${filePath}`);
    }

    console.log(`Running ${tests.length} test(s)...`);

    let passed = 0;
    let failed = 0;

    for (const t of tests) {
        try {
            await t.fn();
            console.log(`✓ ${t.name}`);
            passed++;
        } catch (err) {
            console.error(`✗ ${t.name}`);
            console.error(`  ${err.message || err}`);
            if (err.stack) {
                console.error(`  ${err.stack}`);
            }
            failed++;
        }
    }

    console.log(`\nTest results: ${passed} passed, ${failed} failed, ${tests.length} total.`);

    system.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(`Fatal error running test suite: ${err}`);
    system.exit(1);
});
