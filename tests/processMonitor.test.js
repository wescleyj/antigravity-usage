import GLib from 'gi://GLib';
import {
    test,
    assertEqual,
    assertTrue,
    assertThrows,
} from './assert.js';
import {
    expandHomeDir,
    resolveConfigDir,
    checkAgyRunning,
    getAgyLocalConfig,
    ProcessMonitor,
} from '../src/lib/processMonitor.js';

function getTempDir() {
    const tmp = GLib.build_filenamev([GLib.get_tmp_dir(), 'proc-test-' + Math.random().toString(36).substring(2)]);
    GLib.mkdir_with_parents(tmp, 0o700);
    return tmp;
}

// -------------------------------------------------------------------------
// expandHomeDir & resolveConfigDir tests
// -------------------------------------------------------------------------
test('expandHomeDir: expands ~ and ~/ prefix correctly', () => {
    const home = GLib.get_home_dir();
    assertEqual(expandHomeDir('~'), home, '~ expands to home directory');
    assertEqual(expandHomeDir('~/my/path'), GLib.build_filenamev([home, 'my/path']), '~/ prefix expands to home directory');
    assertEqual(expandHomeDir('/absolute/path'), '/absolute/path', 'absolute path unchanged');
    assertEqual(expandHomeDir('relative/path'), 'relative/path', 'relative path unchanged');
    assertEqual(expandHomeDir(''), '', 'empty string returns empty');
    assertEqual(expandHomeDir(null), '', 'null returns empty string');
    assertEqual(expandHomeDir(undefined), '', 'undefined returns empty string');
});

test('resolveConfigDir: resolves custom dir, env var, and default fallback', () => {
    const home = GLib.get_home_dir();
    const defaultDir = GLib.build_filenamev([home, '.gemini', 'antigravity-cli']);

    // 1. Fallback to default
    GLib.unsetenv('ANTIGRAVITY_CLI_CONFIG_DIR');
    assertEqual(resolveConfigDir(), defaultDir, 'resolves default config dir');

    // 2. Custom dir takes highest priority
    const custom = '/tmp/custom-config';
    assertEqual(resolveConfigDir(custom), custom, 'custom dir overrides all');
    assertEqual(resolveConfigDir('~/custom'), GLib.build_filenamev([home, 'custom']), 'custom dir expands ~');

    // 3. Environment variable takes second priority
    const envDir = '/tmp/env-config';
    GLib.setenv('ANTIGRAVITY_CLI_CONFIG_DIR', envDir, true);
    assertEqual(resolveConfigDir(), envDir, 'resolves ANTIGRAVITY_CLI_CONFIG_DIR');
    assertEqual(resolveConfigDir(custom), custom, 'custom dir overrides env variable');

    GLib.unsetenv('ANTIGRAVITY_CLI_CONFIG_DIR');
});

// -------------------------------------------------------------------------
// checkAgyRunning tests (Zero-fork /proc inspection)
// -------------------------------------------------------------------------
test('checkAgyRunning: detects running process in mock proc directory', () => {
    const mockProc = getTempDir();

    // PID 101: agy
    const p101 = GLib.build_filenamev([mockProc, '101']);
    GLib.mkdir_with_parents(p101, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([p101, 'comm']), 'agy\n');

    // PID 202: other-tool
    const p202 = GLib.build_filenamev([mockProc, '202']);
    GLib.mkdir_with_parents(p202, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([p202, 'comm']), 'bash\n');

    // PID 55: agy
    const p55 = GLib.build_filenamev([mockProc, '55']);
    GLib.mkdir_with_parents(p55, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([p55, 'comm']), 'agy\n');

    // Non-numeric directory: should be ignored
    const notPid = GLib.build_filenamev([mockProc, 'sys']);
    GLib.mkdir_with_parents(notPid, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([notPid, 'comm']), 'agy\n');

    // Ephemeral PID 303: directory without comm file
    const p303 = GLib.build_filenamev([mockProc, '303']);
    GLib.mkdir_with_parents(p303, 0o700);

    // Test detection of agy
    const resAgy = checkAgyRunning(mockProc, 'agy');
    assertTrue(resAgy.running, 'agy must be detected as running');
    assertEqual(resAgy.pids.length, 2, 'must find exactly 2 PIDs');
    assertEqual(resAgy.pids[0], 55, 'PIDs must be sorted numerically (55 first)');
    assertEqual(resAgy.pids[1], 101, 'PIDs must be sorted numerically (101 second)');

    // Test detection of bash
    const resBash = checkAgyRunning(mockProc, 'bash');
    assertTrue(resBash.running, 'bash must be detected as running');
    assertEqual(resBash.pids, [202], 'finds PID 202');

    // Test nonexistent process
    const resNone = checkAgyRunning(mockProc, 'python');
    assertEqual(resNone.running, false, 'python is not running');
    assertEqual(resNone.pids, [], 'pids array is empty');
});

test('checkAgyRunning: handles nonexistent or inaccessible proc paths safely', () => {
    // Nonexistent path
    const resMissing = checkAgyRunning('/tmp/nonexistent-proc-path-12345');
    assertEqual(resMissing.running, false, 'missing path returns running: false');
    assertEqual(resMissing.pids, [], 'missing path returns empty pids');

    // Path that is a file, not a directory
    const tempFile = GLib.build_filenamev([getTempDir(), 'regular_file']);
    GLib.file_set_contents(tempFile, 'not a dir');
    const resFile = checkAgyRunning(tempFile);
    assertEqual(resFile.running, false, 'file path returns running: false');
    assertEqual(resFile.pids, [], 'file path returns empty pids');
});

// -------------------------------------------------------------------------
// getAgyLocalConfig tests
// -------------------------------------------------------------------------
test('getAgyLocalConfig: returns default fallbacks when config files do not exist', () => {
    const emptyConfigDir = getTempDir();
    const config = getAgyLocalConfig(emptyConfigDir);

    assertEqual(config.activeModel, 'Gemini 4 Argon (Medium)', 'default model fallback');
    assertEqual(config.model, 'Gemini 4 Argon (Medium)', 'model alias fallback');
    assertEqual(config.projectId, 'default-cli-project', 'default projectId fallback');
    assertEqual(config.configDir, emptyConfigDir, 'configDir matches input');
});

test('getAgyLocalConfig: reads model from settings.json and projectId from cache', () => {
    const configDir = getTempDir();

    // Create settings.json
    const settingsPath = GLib.build_filenamev([configDir, 'settings.json']);
    GLib.file_set_contents(settingsPath, JSON.stringify({
        model: 'Claude Opus 5.5 (Medium)',
        otherField: true,
    }));

    // Create cache/default_project_id.txt
    const cacheDir = GLib.build_filenamev([configDir, 'cache']);
    GLib.mkdir_with_parents(cacheDir, 0o700);
    const projectPath = GLib.build_filenamev([cacheDir, 'default_project_id.txt']);
    GLib.file_set_contents(projectPath, '  my-custom-project-123  \n');

    const config = getAgyLocalConfig(configDir);
    assertEqual(config.activeModel, 'Claude Opus 5.5 (Medium)', 'reads activeModel from settings.json');
    assertEqual(config.model, 'Claude Opus 5.5 (Medium)', 'reads model from settings.json');
    assertEqual(config.projectId, 'my-custom-project-123', 'reads and trims projectId from cache file');
    assertEqual(config.configDir, configDir, 'returns configDir');
});

test('getAgyLocalConfig: sanitizes model and validates projectId against injection', () => {
    const configDir = getTempDir();

    // 1. settings.json with control characters
    const settingsPath = GLib.build_filenamev([configDir, 'settings.json']);
    GLib.file_set_contents(settingsPath, JSON.stringify({
        model: 'Gemini\x00 3.8 Flash\x1F\n',
    }));

    // 2. default_project_id.txt with illegal characters (path traversal attempt)
    const cacheDir = GLib.build_filenamev([configDir, 'cache']);
    GLib.mkdir_with_parents(cacheDir, 0o700);
    const projectPath = GLib.build_filenamev([cacheDir, 'default_project_id.txt']);
    GLib.file_set_contents(projectPath, '../../etc/passwd');

    const config = getAgyLocalConfig(configDir);
    assertEqual(config.activeModel, 'Gemini 3.8 Flash', 'control characters stripped from model');
    assertEqual(config.projectId, 'default-cli-project', 'path traversal string rejected and reverted to fallback');
});

test('getAgyLocalConfig: handles malformed or non-string settings gracefully', () => {
    const configDir = getTempDir();

    // Corrupt settings.json
    const settingsPath = GLib.build_filenamev([configDir, 'settings.json']);
    GLib.file_set_contents(settingsPath, '{ corrupt json !!!');

    const config = getAgyLocalConfig(configDir);
    assertEqual(config.activeModel, 'Gemini 4 Argon (Medium)', 'malformed JSON falls back safely');
    assertEqual(config.projectId, 'default-cli-project', 'projectId fallback');
});

// -------------------------------------------------------------------------
// ProcessMonitor class tests
// -------------------------------------------------------------------------
test('ProcessMonitor: wrapper class methods operate correctly', () => {
    const mockProc = getTempDir();
    const configDir = getTempDir();

    // Create a mock process
    const p12 = GLib.build_filenamev([mockProc, '12']);
    GLib.mkdir_with_parents(p12, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([p12, 'comm']), 'agy\n');

    // Create settings.json
    GLib.file_set_contents(GLib.build_filenamev([configDir, 'settings.json']), JSON.stringify({
        model: 'GPT-OSS 120B',
    }));

    const monitor = new ProcessMonitor(mockProc, configDir);
    const runStatus = monitor.isAgyRunning();
    assertTrue(runStatus.running, 'monitor.isAgyRunning detects agy');
    assertEqual(runStatus.pids, [12], 'monitor detects pid 12');

    const cfg = monitor.getConfig();
    assertEqual(cfg.activeModel, 'GPT-OSS 120B', 'monitor.getConfig retrieves model');
});

// -------------------------------------------------------------------------
// QA Edge-Case & Robustness Tests (Issue #2 Acceptance Criteria)
// -------------------------------------------------------------------------
test('QA Edge Case: checkAgyRunning handles multiple agy processes and sorts PIDs numerically', () => {
    const mockProc = getTempDir();
    const unsortedPids = [99999, 1, 400, 25, 1024];

    for (const pid of unsortedPids) {
        const pDir = GLib.build_filenamev([mockProc, String(pid)]);
        GLib.mkdir_with_parents(pDir, 0o700);
        GLib.file_set_contents(GLib.build_filenamev([pDir, 'comm']), 'agy\n');
    }

    const res = checkAgyRunning(mockProc, 'agy');
    assertTrue(res.running, 'multiple agy processes must be marked as running');
    assertEqual(res.pids.length, 5, 'must detect all 5 processes');
    assertEqual(res.pids, [1, 25, 400, 1024, 99999], 'PIDs must be numerically sorted');
});

test('QA Edge Case: checkAgyRunning ignores non-numeric, negative and malformed PID directories in /proc', () => {
    const mockProc = getTempDir();

    // Valid PID
    const validP = GLib.build_filenamev([mockProc, '42']);
    GLib.mkdir_with_parents(validP, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([validP, 'comm']), 'agy\n');

    // Non-numeric alphanumeric
    const alphaDir = GLib.build_filenamev([mockProc, '42abc']);
    GLib.mkdir_with_parents(alphaDir, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([alphaDir, 'comm']), 'agy\n');

    // Negative directory name
    const negDir = GLib.build_filenamev([mockProc, '-10']);
    GLib.mkdir_with_parents(negDir, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([negDir, 'comm']), 'agy\n');

    // Special system proc names
    const sysDir = GLib.build_filenamev([mockProc, 'self']);
    GLib.mkdir_with_parents(sysDir, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([sysDir, 'comm']), 'agy\n');

    const res = checkAgyRunning(mockProc, 'agy');
    assertTrue(res.running, 'detects running valid process');
    assertEqual(res.pids, [42], 'only strictly numeric positive PID directory is parsed');
});

test('QA Edge Case: checkAgyRunning operates safely against host /proc filesystem', () => {
    const res = checkAgyRunning('/proc', 'agy');
    assertEqual(typeof res.running, 'boolean', 'running is boolean');
    assertTrue(Array.isArray(res.pids), 'pids is an array');
});

test('QA Edge Case: getAgyLocalConfig follows valid symlinks for settings.json and default_project_id.txt', () => {
    const configDir = getTempDir();
    const realDir = getTempDir();

    // 1. Valid symlink for settings.json
    const realSettings = GLib.build_filenamev([realDir, 'source_settings.json']);
    GLib.file_set_contents(realSettings, JSON.stringify({ model: 'Claude Sonnet 5.5' }));
    const symSettings = GLib.build_filenamev([configDir, 'settings.json']);
    GLib.spawn_command_line_sync(`ln -s "${realSettings}" "${symSettings}"`);

    // 2. Valid symlink for cache/default_project_id.txt
    const cacheDir = GLib.build_filenamev([configDir, 'cache']);
    GLib.mkdir_with_parents(cacheDir, 0o700);
    const realProject = GLib.build_filenamev([realDir, 'source_project.txt']);
    GLib.file_set_contents(realProject, 'symlinked-project-id\n');
    const symProject = GLib.build_filenamev([cacheDir, 'default_project_id.txt']);
    GLib.spawn_command_line_sync(`ln -s "${realProject}" "${symProject}"`);

    const cfg = getAgyLocalConfig(configDir);
    assertEqual(cfg.activeModel, 'Claude Sonnet 5.5', 'reads model through symlink');
    assertEqual(cfg.projectId, 'symlinked-project-id', 'reads projectId through symlink');
});

test('QA Edge Case: getAgyLocalConfig handles broken symlinks safely by falling back to defaults', () => {
    const configDir = getTempDir();
    const cacheDir = GLib.build_filenamev([configDir, 'cache']);
    GLib.mkdir_with_parents(cacheDir, 0o700);

    const brokenSettings = GLib.build_filenamev([configDir, 'settings.json']);
    GLib.spawn_command_line_sync(`ln -s "/tmp/nonexistent-target-${Math.random()}" "${brokenSettings}"`);

    const brokenProject = GLib.build_filenamev([cacheDir, 'default_project_id.txt']);
    GLib.spawn_command_line_sync(`ln -s "/tmp/nonexistent-target-${Math.random()}" "${brokenProject}"`);

    const cfg = getAgyLocalConfig(configDir);
    assertEqual(cfg.activeModel, 'Gemini 4 Argon (Medium)', 'broken settings symlink falls back to default model');
    assertEqual(cfg.projectId, 'default-cli-project', 'broken project symlink falls back to default projectId');
});

test('QA Edge Case: getAgyLocalConfig handles 0-byte (empty) settings.json and default_project_id.txt safely', () => {
    const configDir = getTempDir();
    const cacheDir = GLib.build_filenamev([configDir, 'cache']);
    GLib.mkdir_with_parents(cacheDir, 0o700);

    // 0-byte settings.json
    GLib.file_set_contents(GLib.build_filenamev([configDir, 'settings.json']), '');

    // 0-byte default_project_id.txt
    GLib.file_set_contents(GLib.build_filenamev([cacheDir, 'default_project_id.txt']), '');

    const cfg = getAgyLocalConfig(configDir);
    assertEqual(cfg.activeModel, 'Gemini 4 Argon (Medium)', 'empty settings.json falls back to default model');
    assertEqual(cfg.projectId, 'default-cli-project', 'empty default_project_id.txt falls back to default projectId');
});

test('QA Edge Case: getAgyLocalConfig handles null, array, empty or non-string model values in settings.json', () => {
    const configDir = getTempDir();
    const sPath = GLib.build_filenamev([configDir, 'settings.json']);

    // 1. null file content
    GLib.file_set_contents(sPath, 'null');
    assertEqual(getAgyLocalConfig(configDir).activeModel, 'Gemini 4 Argon (Medium)', 'null content falls back');

    // 2. array file content
    GLib.file_set_contents(sPath, '[]');
    assertEqual(getAgyLocalConfig(configDir).activeModel, 'Gemini 4 Argon (Medium)', 'array content falls back');

    // 3. model is empty string
    GLib.file_set_contents(sPath, JSON.stringify({ model: '' }));
    assertEqual(getAgyLocalConfig(configDir).activeModel, 'Gemini 4 Argon (Medium)', 'empty model falls back');

    // 4. model is whitespace only
    GLib.file_set_contents(sPath, JSON.stringify({ model: '   \n \t  ' }));
    assertEqual(getAgyLocalConfig(configDir).activeModel, 'Gemini 4 Argon (Medium)', 'whitespace model falls back');

    // 5. model is a number
    GLib.file_set_contents(sPath, JSON.stringify({ model: 42 }));
    assertEqual(getAgyLocalConfig(configDir).activeModel, 'Gemini 4 Argon (Medium)', 'numeric model falls back');
});

test('QA Edge Case: getAgyLocalConfig rejects whitespace-only or invalid/injection project IDs and falls back to default', () => {
    const configDir = getTempDir();
    const cacheDir = GLib.build_filenamev([configDir, 'cache']);
    GLib.mkdir_with_parents(cacheDir, 0o700);
    const pPath = GLib.build_filenamev([cacheDir, 'default_project_id.txt']);

    // 1. Whitespace only
    GLib.file_set_contents(pPath, '   \t  \n  ');
    assertEqual(getAgyLocalConfig(configDir).projectId, 'default-cli-project', 'whitespace project falls back');

    // 2. Command injection chars
    GLib.file_set_contents(pPath, 'proj; rm -rf /');
    assertEqual(getAgyLocalConfig(configDir).projectId, 'default-cli-project', 'injection project falls back');

    // 3. Spaces inside project id
    GLib.file_set_contents(pPath, 'invalid project id with spaces');
    assertEqual(getAgyLocalConfig(configDir).projectId, 'default-cli-project', 'spaces in project falls back');
});

