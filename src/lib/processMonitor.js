import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DEFAULT_MODEL = 'Gemini 4 Argon (Medium)';
export const DEFAULT_PROJECT_ID = 'default-cli-project';
export const SAFE_PROJECT_ID_REGEX = /^[a-zA-Z0-9_.-]{1,128}$/;

/**
 * Expands ~ and ~/ in path strings to the user's home directory.
 *
 * @param {string|null} pathStr
 * @returns {string}
 */
export function expandHomeDir(pathStr) {
    if (!pathStr || typeof pathStr !== 'string') {
        return '';
    }

    const home = GLib.get_home_dir();
    if (pathStr === '~') {
        return home;
    }
    if (pathStr.startsWith('~/')) {
        return GLib.build_filenamev([home, pathStr.slice(2)]);
    }
    return pathStr;
}

/**
 * Resolves the configuration directory for Antigravity CLI (`agy`).
 * Priority: customDir -> ANTIGRAVITY_CLI_CONFIG_DIR -> ~/.gemini/antigravity-cli
 *
 * @param {string|null} customDir
 * @returns {string}
 */
export function resolveConfigDir(customDir = null) {
    if (customDir && typeof customDir === 'string' && customDir.trim() !== '') {
        return expandHomeDir(customDir.trim());
    }

    const envDir = GLib.getenv('ANTIGRAVITY_CLI_CONFIG_DIR');
    if (envDir && typeof envDir === 'string' && envDir.trim() !== '') {
        return expandHomeDir(envDir.trim());
    }

    return GLib.build_filenamev([GLib.get_home_dir(), '.gemini', 'antigravity-cli']);
}

/**
 * Inspects `/proc` in-memory to detect if the target CLI process (`agy`) is running.
 * Performs zero fork/exec calls for optimal power and performance.
 *
 * @param {string} [procRootPath='/proc'] - Path to /proc filesystem (configurable for testing)
 * @param {string} [targetProcessName='agy'] - Target process name in /proc/<pid>/comm
 * @returns {{ running: boolean, pids: number[] }}
 */
export function checkAgyRunning(procRootPath = '/proc', targetProcessName = 'agy') {
    if (!procRootPath || typeof procRootPath !== 'string') {
        return { running: false, pids: [] };
    }

    if (!GLib.file_test(procRootPath, GLib.FileTest.IS_DIR)) {
        return { running: false, pids: [] };
    }

    const pids = [];
    const procDir = Gio.File.new_for_path(procRootPath);

    let enumerator = null;
    try {
        enumerator = procDir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            // Filter strictly numeric directory names (PIDs)
            if (!/^\d+$/.test(name)) {
                continue;
            }

            const pid = parseInt(name, 10);
            const commPath = GLib.build_filenamev([procRootPath, name, 'comm']);

            try {
                const [ok, data] = GLib.file_get_contents(commPath);
                if (ok) {
                    const comm = new TextDecoder('utf-8').decode(data).trim();
                    if (comm === targetProcessName) {
                        pids.push(pid);
                    }
                }
            } catch (readErr) {
                // Ignore ephemeral processes that exited or permission errors
            }
        }
    } catch (enumErr) {
        // Proc directory unreadable or inaccessible
        return { running: false, pids: [] };
    } finally {
        if (enumerator) {
            try {
                enumerator.close(null);
            } catch (closeErr) {
                // Ignore close error
            }
        }
    }

    pids.sort((a, b) => a - b);
    return {
        running: pids.length > 0,
        pids,
    };
}

/**
 * Reads local Antigravity CLI configuration: active model and default project ID.
 *
 * @param {string|null} [configDirPath=null] - Optional custom config dir
 * @returns {{ activeModel: string, model: string, projectId: string, configDir: string }}
 */
export function getAgyLocalConfig(configDirPath = null) {
    const configDir = resolveConfigDir(configDirPath);
    let activeModel = DEFAULT_MODEL;
    let projectId = DEFAULT_PROJECT_ID;

    // 1. Read ~/.gemini/antigravity-cli/settings.json
    const settingsPath = GLib.build_filenamev([configDir, 'settings.json']);
    if (GLib.file_test(settingsPath, GLib.FileTest.EXISTS)) {
        try {
            const [ok, data] = GLib.file_get_contents(settingsPath);
            if (ok) {
                const text = new TextDecoder('utf-8').decode(data);
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object' && typeof parsed.model === 'string') {
                    // Sanitize control characters (ASCII 0-31 and 127) and limit length
                    const sanitized = parsed.model.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 128);
                    if (sanitized.length > 0) {
                        activeModel = sanitized;
                    }
                }
            }
        } catch (settingsErr) {
            // Keep default model on parse/read error
        }
    }

    // 2. Read ~/.gemini/antigravity-cli/cache/default_project_id.txt
    const projectPath = GLib.build_filenamev([configDir, 'cache', 'default_project_id.txt']);
    if (GLib.file_test(projectPath, GLib.FileTest.EXISTS)) {
        try {
            const [ok, data] = GLib.file_get_contents(projectPath);
            if (ok) {
                const text = new TextDecoder('utf-8').decode(data).trim();
                if (SAFE_PROJECT_ID_REGEX.test(text)) {
                    projectId = text;
                }
            }
        } catch (projectErr) {
            // Keep default project ID on read error
        }
    }

    return {
        activeModel,
        model: activeModel,
        projectId,
        configDir,
    };
}

/**
 * Process and configuration monitor utility for `agy`.
 */
export class ProcessMonitor {
    /**
     * @param {string} [procRootPath='/proc']
     * @param {string|null} [configDirPath=null]
     */
    constructor(procRootPath = '/proc', configDirPath = null) {
        this._procRootPath = procRootPath;
        this._configDirPath = configDirPath;
    }

    /**
     * Checks if the `agy` process is currently running.
     *
     * @param {string} [targetProcessName='agy']
     * @returns {{ running: boolean, pids: number[] }}
     */
    isAgyRunning(targetProcessName = 'agy') {
        return checkAgyRunning(this._procRootPath, targetProcessName);
    }

    /**
     * Retrieves the local CLI configuration (active model and project ID).
     *
     * @returns {{ activeModel: string, model: string, projectId: string, configDir: string }}
     */
    getConfig() {
        return getAgyLocalConfig(this._configDirPath);
    }
}
