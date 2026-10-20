import { AGY_MODEL_FAMILIES } from './api.js';
import { RELOAD_OPTIONS } from './scheduler.js';
import { formatDuration } from './history.js';

/**
 * Truncates string if it exceeds maxLen, appending '...' safely.
 *
 * @param {string|null} str
 * @param {number} [maxLen=30]
 * @returns {string}
 */
export function truncateString(str, maxLen = 30) {
    if (!str || typeof str !== 'string') {
        return '';
    }
    if (str.length <= maxLen) {
        return str;
    }
    return str.slice(0, Math.max(0, maxLen - 3)) + '...';
}

/**
 * Returns quota health status, color class, and icon indicator based on remaining fraction.
 *
 * Thresholds:
 * - <= 0.20 (20%): Critical (red / quota-crit)
 * - <= 0.50 (50%): Warning (yellow / quota-warn)
 * - > 0.50: Good (green / quota-good)
 *
 * @param {number|null} remainingFraction
 * @returns {{ level: 'good'|'warn'|'crit', label: string, colorClass: string, iconClass: string }}
 */
export function getQuotaHealth(remainingFraction) {
    if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) {
        return {
            level: 'good',
            label: 'Saudável',
            colorClass: 'quota-good',
            iconClass: 'quota-icon-good',
        };
    }

    const clamped = Math.max(0.0, Math.min(1.0, remainingFraction));

    if (clamped <= 0.20) {
        return {
            level: 'crit',
            label: 'Crítico',
            colorClass: 'quota-crit',
            iconClass: 'quota-icon-crit',
        };
    }

    if (clamped <= 0.50) {
        return {
            level: 'warn',
            label: 'Atenção',
            colorClass: 'quota-warn',
            iconClass: 'quota-icon-warn',
        };
    }

    return {
        level: 'good',
        label: 'Saudável',
        colorClass: 'quota-good',
        iconClass: 'quota-icon-good',
    };
}

/**
 * Formats top bar indicator text next to the symbolic icon.
 *
 * @param {object|null} snapshot
 * @param {object} [options={}]
 * @param {boolean} [options.includeModel=false]
 * @param {boolean} [options.error=false]
 * @returns {string}
 */
export function formatTopBarText(snapshot, { includeModel = false, error = false } = {}) {
    if (error) {
        return 'Erro';
    }

    if (!snapshot || snapshot.lowestRemainingPercent === null || snapshot.lowestRemainingPercent === undefined) {
        return '...';
    }

    const pct = Math.round(Number(snapshot.lowestRemainingPercent));
    if (!Number.isFinite(pct)) {
        return '...';
    }

    let text = `${pct}%`;

    if (includeModel && snapshot.activeFamily && snapshot.activeFamily.displayName) {
        const shortModel = snapshot.activeFamily.displayName
            .replace(/^Gemini\s+(\d+(\.\d+)?\s+)?/i, '')
            .replace(/^Claude\s+/i, '')
            .replace(/^GPT-OSS\s+/i, 'GPT ')
            .trim();
        text = `${shortModel}: ${text}`;
    }

    return truncateString(text, 25);
}

/**
 * Formats a unix timestamp (milliseconds) to HH:MM local clock time.
 *
 * @param {number|null} timestampMs
 * @returns {string}
 */
export function formatClockTime(timestampMs) {
    if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs) || timestampMs <= 0) {
        return '--:--';
    }

    const d = new Date(timestampMs);
    if (Number.isNaN(d.getTime())) {
        return '--:--';
    }

    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

/**
 * Formats header state including project name, active model, process status, and update timestamp.
 *
 * @param {object|null} snapshot
 * @param {boolean} [processRunning=false]
 * @returns {object}
 */
export function formatHeaderState(snapshot, processRunning = false) {
    const rawProjectId = snapshot?.projectId || 'default-cli-project';
    const projectId = truncateString(rawProjectId, 35);

    const activeModel = truncateString(snapshot?.activeModel || 'Gemini 4 Argon (Medium)', 40);
    const activeFamilyName = snapshot?.activeFamily?.displayName || 'Gemini 4 Argon';

    const processStatus = processRunning
        ? { label: 'CLI Ativo', badgeClass: 'badge-active', isRunning: true }
        : { label: 'CLI Fechado', badgeClass: 'badge-inactive', isRunning: false };

    const lastUpdatedFormatted = formatClockTime(snapshot?.timestamp || null);

    return {
        projectId,
        activeModel,
        activeFamilyName,
        processStatus,
        lastUpdatedFormatted,
    };
}

/**
 * Formats a quota bucket into a card model ready for popup presentation.
 *
 * @param {object|null} bucket
 * @param {string} [fallbackBucketId='gemini-weekly']
 * @returns {object}
 */
export function formatBucketCard(bucket, fallbackBucketId = 'gemini-weekly') {
    const bucketId = bucket?.bucketId || fallbackBucketId;
    const isWeekly = (bucket?.windowType === 'weekly') || bucketId.includes('weekly');
    const windowTitle = isWeekly ? 'Semanal (7 dias)' : 'Burst (5 horas)';

    const remFrac = Math.max(0.0, Math.min(1.0, typeof bucket?.remainingFraction === 'number' ? bucket.remainingFraction : 1.0));
    const usedFrac = Math.max(0.0, Math.min(1.0, typeof bucket?.usedFraction === 'number' ? bucket.usedFraction : (1.0 - remFrac)));

    const remPct = remFrac * 100;
    const usedPct = usedFrac * 100;

    const health = getQuotaHealth(remFrac);

    const resetIn = bucket?.resetInFormatted || (bucket?.resetInMs ? formatDuration(bucket.resetInMs) : '0m');
    const resetText = `Reinicia em ${resetIn}`;

    const burnPerHour = (typeof bucket?.burnPercentPerHour === 'number' && Number.isFinite(bucket.burnPercentPerHour))
        ? bucket.burnPercentPerHour
        : 0.0;
    const burnRateText = `${burnPerHour.toFixed(1)}%/h`;

    const willExhaust = Boolean(bucket?.willExhaustBeforeReset);
    const autonomyText = bucket?.estimatedLabel || (willExhaust
        ? `Esgota em ${bucket?.estimatedDurationFormatted || 'breve'}`
        : 'Seguro até o reset');

    return {
        bucketId,
        windowTitle,
        windowType: isWeekly ? 'weekly' : '5h',
        remainingFraction: remFrac,
        usedFraction: usedFrac,
        remainingPercent: remPct,
        usedPercent: usedPct,
        remainingPercentFormatted: `${Math.round(remPct)}%`,
        usedPercentFormatted: `${Math.round(usedPct)}%`,
        health,
        resetText,
        burnRateText,
        autonomyText,
        willExhaustBeforeReset: willExhaust,
    };
}

/**
 * Formats the 5 canonical model families with quota fractions and active status pill.
 *
 * @param {Array|null} families
 * @param {string} [activeModelStr='']
 * @returns {Array<object>}
 */
export function formatModelFamiliesList(families, activeModelStr = '') {
    const list = Array.isArray(families) && families.length > 0
        ? families
        : AGY_MODEL_FAMILIES.map(fam => ({
            id: fam.id,
            displayName: fam.displayName,
            group: fam.group,
            defaultTier: fam.defaultTier,
            remainingFraction: 1.0,
            remainingPercent: 100,
            isActive: fam.id === 'gemini-4-argon',
        }));

    return list.map(fam => {
        const remFrac = Math.max(0.0, Math.min(1.0, typeof fam.remainingFraction === 'number' ? fam.remainingFraction : 1.0));
        const remPct = remFrac * 100;
        const health = getQuotaHealth(remFrac);
        const isActive = Boolean(fam.isActive);

        return {
            id: fam.id,
            displayName: fam.displayName,
            group: fam.group,
            defaultTier: fam.defaultTier || 'Medium',
            remainingFraction: remFrac,
            remainingPercent: remPct,
            remainingPercentFormatted: `${Math.round(remPct)}%`,
            health,
            isActive,
            activeBadge: isActive ? 'ATIVO' : null,
        };
    });
}

/**
 * Formats the reload options for the popup menu.
 *
 * @param {number|string} [currentMode='auto']
 * @param {boolean} [processRunning=false]
 * @returns {Array<object>}
 */
export function formatReloadMenuOptions(currentMode = 'auto', processRunning = false) {
    const isAutoSelected = currentMode === 'auto' || currentMode === 180;

    return [
        {
            id: 'auto',
            label: 'Automático',
            seconds: processRunning ? 180 : 1800,
            modeValue: 'auto',
            isSelected: isAutoSelected,
            detail: processRunning ? 'Auto (3m ativo)' : 'Auto (30m ocioso)',
        },
        {
            id: '1m',
            label: '1 minuto',
            seconds: 60,
            modeValue: 60,
            isSelected: !isAutoSelected && currentMode === 60,
            detail: '60s',
        },
        {
            id: '5m',
            label: '5 minutos',
            seconds: 300,
            modeValue: 300,
            isSelected: !isAutoSelected && currentMode === 300,
            detail: '5m',
        },
        {
            id: '15m',
            label: '15 minutos',
            seconds: 900,
            modeValue: 900,
            isSelected: !isAutoSelected && currentMode === 900,
            detail: '15m',
        },
        {
            id: '30m',
            label: '30 minutos',
            seconds: 1800,
            modeValue: 1800,
            isSelected: !isAutoSelected && currentMode === 1800,
            detail: '30m',
        },
        {
            id: '1h',
            label: '1 hora',
            seconds: 3600,
            modeValue: 3600,
            isSelected: !isAutoSelected && currentMode === 3600,
            detail: '1h',
        },
    ];
}
