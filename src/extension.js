import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { UsageHistoryStore } from './lib/history.js';
import { AntigravityQuotaClient } from './lib/api.js';
import { ReloadScheduler } from './lib/scheduler.js';
import { checkAgyRunning, getAgyLocalConfig } from './lib/processMonitor.js';
import {
    getQuotaHealth,
    formatTopBarText,
    formatHeaderState,
    formatBucketCard,
    formatModelFamiliesList,
    formatReloadMenuOptions,
} from './lib/viewModel.js';

// Dynamically import GNOME Shell modules to maintain compatibility across GNOME Shell 45-52
// while permitting standalone testing in GJS CI/unit test environments
let ExtensionBase;
try {
    const extModule = await import('resource:///org/gnome/shell/extensions/extension.js');
    ExtensionBase = extModule.Extension;
} catch (e) {
    ExtensionBase = class FallbackExtension {
        constructor(metadata) {
            this.metadata = metadata || {};
            this.uuid = metadata?.uuid || 'antigravity-usage@wescley.dev';
            this.path = metadata?.path || '';
        }
        enable() {}
        disable() {}
    };
}

let Main = null;
let PanelMenu = null;
let PopupMenu = null;
let St = null;
let Clutter = null;

try {
    Main = await import('resource:///org/gnome/shell/ui/main.js');
    PanelMenu = await import('resource:///org/gnome/shell/ui/panelMenu.js');
    PopupMenu = await import('resource:///org/gnome/shell/ui/popupMenu.js');
    St = (await import('gi://St')).default;
    Clutter = (await import('gi://Clutter')).default;
} catch (e) {
    // Shell UI modules unavailable outside of running GNOME Shell compositor
}

/**
 * Antigravity Quota Usage Extension for GNOME Shell 45-52
 */
export default class AntigravityUsageExtension extends ExtensionBase {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._historyStore = null;
        this._client = null;
        this._scheduler = null;
        this._latestSnapshot = null;
        this._isProcessRunning = false;
        this._topBarLabel = null;
        this._topBarIcon = null;
        this._popupContainer = null;
    }

    /**
     * Called by GNOME Shell when the extension is enabled.
     */
    enable() {
        this._historyStore = new UsageHistoryStore();
        this._client = new AntigravityQuotaClient({
            historyStore: this._historyStore,
            configProvider: getAgyLocalConfig,
        });

        this._scheduler = new ReloadScheduler({
            historyStore: this._historyStore,
            processChecker: checkAgyRunning,
            onReload: async () => this._refresh(),
        });

        if (PanelMenu && Main && St) {
            this._buildIndicator();
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        }

        this._scheduler.start();
        this._refresh().catch(() => {});
    }

    /**
     * Called by GNOME Shell when the extension is disabled.
     */
    disable() {
        if (this._scheduler) {
            try {
                this._scheduler.destroy();
            } catch (e) {}
            this._scheduler = null;
        }

        if (this._client) {
            try {
                this._client.destroy();
            } catch (e) {}
            this._client = null;
        }

        if (this._indicator) {
            try {
                this._indicator.destroy();
            } catch (e) {}
            this._indicator = null;
        }

        this._historyStore = null;
        this._latestSnapshot = null;
        this._topBarLabel = null;
        this._topBarIcon = null;
        this._popupContainer = null;
    }

    /**
     * Cleans up all resources.
     */
    destroy() {
        this.disable();
    }

    /**
     * Builds the Top Bar status button and popup menu widgets.
     *
     * @private
     */
    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata?.name || 'Antigravity Quota', false);
        this._indicator.add_style_class_name('antigravity-panel-button');

        const box = new St.BoxLayout({
            style_class: 'antigravity-panel-box',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Symbolic Icon
        const iconPath = GLib.build_filenamev([this.path || '.', 'icons', 'antigravity-symbolic.svg']);
        const gicon = Gio.FileIcon.new(Gio.File.new_for_path(iconPath));
        this._topBarIcon = new St.Icon({
            gicon: gicon,
            style_class: 'system-status-icon antigravity-panel-icon',
        });
        box.add_child(this._topBarIcon);

        // Top Bar Label
        this._topBarLabel = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'antigravity-panel-label',
        });
        box.add_child(this._topBarLabel);

        this._indicator.add_child(box);

        // Popup Menu Container
        const menu = this._indicator.menu;
        menu.box.add_style_class_name('antigravity-popup-menu');

        this._popupContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'antigravity-popup-container',
        });

        const menuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        menuItem.add_child(this._popupContainer);
        menu.addMenuItem(menuItem);

        this._renderPopupMenuLoading();
    }

    /**
     * Fetches current process status and quota snapshot, updating the UI.
     *
     * @private
     */
    async _refresh() {
        this._isProcessRunning = checkAgyRunning();

        try {
            if (this._client) {
                this._latestSnapshot = await this._client.fetchUsageSnapshot();
            }
            this._updateUI(false);
        } catch (err) {
            this._updateUI(true);
        }
    }

    /**
     * Updates top bar text, icon styles, and popup menu content.
     *
     * @param {boolean} [hasError=false]
     * @private
     */
    _updateUI(hasError = false) {
        if (!this._indicator) return;

        // 1. Update Top Bar Label & Health
        const showPanelPercent = this._historyStore
            ? this._historyStore.getSettings().showPanelPercent
            : true;

        if (this._topBarLabel) {
            if (showPanelPercent === false) {
                this._topBarLabel.text = '';
            } else {
                this._topBarLabel.text = formatTopBarText(this._latestSnapshot, { error: hasError });
            }
        }

        if (this._topBarIcon) {
            const health = getQuotaHealth(
                this._latestSnapshot?.lowestRemainingPercent != null
                    ? this._latestSnapshot.lowestRemainingPercent / 100
                    : 1.0
            );
            this._topBarIcon.remove_style_class_name('quota-good');
            this._topBarIcon.remove_style_class_name('quota-warn');
            this._topBarIcon.remove_style_class_name('quota-crit');
            this._topBarIcon.add_style_class_name(health.colorClass);
        }

        // 2. Update Popup Menu Content
        this._renderPopupMenu(hasError);
    }

    /**
     * Renders loading state in popup menu.
     *
     * @private
     */
    _renderPopupMenuLoading() {
        if (!this._popupContainer || !St) return;
        this._popupContainer.destroy_all_children();

        const loadingLabel = new St.Label({
            text: 'Carregando cotas do Antigravity CLI...',
            style_class: 'antigravity-header-subtitle',
            x_align: Clutter.ActorAlign.CENTER,
            margin_top: 10,
            margin_bottom: 10,
        });
        this._popupContainer.add_child(loadingLabel);
    }

    /**
     * Renders the complete popup menu with header, quota cards, models list, and controls.
     *
     * @param {boolean} hasError
     * @private
     */
    _renderPopupMenu(hasError) {
        if (!this._popupContainer || !St) return;
        this._popupContainer.destroy_all_children();

        const headerState = formatHeaderState(this._latestSnapshot, this._isProcessRunning);

        // Header Section
        const headerBox = new St.BoxLayout({
            vertical: true,
            style_class: 'antigravity-popup-header',
        });

        const topRow = new St.BoxLayout({ x_expand: true });
        const titleLabel = new St.Label({
            text: headerState.activeFamilyName,
            style_class: 'antigravity-header-title',
            x_expand: true,
        });
        topRow.add_child(titleLabel);

        const badgeLabel = new St.Label({
            text: headerState.processStatus.label,
            style_class: headerState.processStatus.badgeClass,
        });
        topRow.add_child(badgeLabel);
        headerBox.add_child(topRow);

        const projectLabel = new St.Label({
            text: `Projeto: ${headerState.projectId}`,
            style_class: 'antigravity-header-subtitle',
        });
        headerBox.add_child(projectLabel);

        const updatedLabel = new St.Label({
            text: `Atualizado às ${headerState.lastUpdatedFormatted}`,
            style_class: 'antigravity-header-subtitle',
        });
        headerBox.add_child(updatedLabel);
        this._popupContainer.add_child(headerBox);

        // Quota Cards Section: Gemini Models
        const buckets = this._latestSnapshot?.buckets || {};

        const geminiHeader = new St.Label({
            text: 'Cotas Gemini (Google)',
            style_class: 'quota-group-header',
        });
        this._popupContainer.add_child(geminiHeader);

        const geminiWeekly = formatBucketCard(buckets['gemini-weekly'], 'gemini-weekly');
        const geminiBurst = formatBucketCard(buckets['gemini-5h'], 'gemini-5h');
        this._popupContainer.add_child(this._createCardWidget(geminiWeekly));
        this._popupContainer.add_child(this._createCardWidget(geminiBurst));

        // Quota Cards Section: Claude & GPT Models (3P)
        const thirdPartyHeader = new St.Label({
            text: 'Cotas Claude & GPT (3P)',
            style_class: 'quota-group-header',
        });
        this._popupContainer.add_child(thirdPartyHeader);

        const thirdPartyWeekly = formatBucketCard(buckets['3p-weekly'], '3p-weekly');
        const thirdPartyBurst = formatBucketCard(buckets['3p-5h'], '3p-5h');
        this._popupContainer.add_child(this._createCardWidget(thirdPartyWeekly));
        this._popupContainer.add_child(this._createCardWidget(thirdPartyBurst));

        // Model Families Header & List
        const modelsTitle = new St.Label({
            text: 'Famílias de Modelos',
            style_class: 'model-families-header',
        });
        this._popupContainer.add_child(modelsTitle);

        const families = formatModelFamiliesList(
            this._latestSnapshot?.families,
            this._latestSnapshot?.activeModel
        );

        for (const fam of families) {
            const row = new St.BoxLayout({
                style_class: 'model-family-item',
                x_expand: true,
            });

            const nameLabel = new St.Label({
                text: fam.displayName,
                style_class: 'model-family-name',
                x_expand: true,
            });
            row.add_child(nameLabel);

            if (fam.activeBadge) {
                const pill = new St.Label({
                    text: fam.activeBadge,
                    style_class: 'model-active-pill',
                });
                row.add_child(pill);
            }

            const pctLabel = new St.Label({
                text: fam.remainingPercentFormatted,
                style_class: `model-quota-percent ${fam.health.colorClass}`,
            });
            row.add_child(pctLabel);

            this._popupContainer.add_child(row);
        }

        // Section: Reload Mode Options
        const reloadTitle = new St.Label({
            text: 'Intervalo de Atualização',
            style_class: 'model-families-header',
        });
        this._popupContainer.add_child(reloadTitle);

        const currentMode = this._scheduler ? this._scheduler.getMode() : 'auto';
        const reloadOptions = formatReloadMenuOptions(currentMode, this._isProcessRunning);

        const reloadBox = new St.BoxLayout({
            style_class: 'reload-options-box',
            x_expand: true,
        });

        for (const opt of reloadOptions) {
            const btn = new St.Button({
                label: opt.isSelected ? `✓ ${opt.label}` : opt.label,
                style_class: opt.isSelected ? 'button reload-btn-selected' : 'button reload-btn',
                can_focus: true,
            });
            btn.connect('clicked', () => {
                if (this._scheduler) {
                    this._scheduler.setReloadMode(opt.id);
                }
                this._updateUI(hasError);
            });
            reloadBox.add_child(btn);
        }
        this._popupContainer.add_child(reloadBox);

        // Section: Settings (showPanelPercent toggle)
        const toggleRow = new St.BoxLayout({
            style_class: 'model-family-item',
            x_expand: true,
        });
        const toggleLabel = new St.Label({
            text: 'Exibir percentual na barra superior',
            style_class: 'model-family-name',
            x_expand: true,
        });
        toggleRow.add_child(toggleLabel);

        const showPercent = this._historyStore
            ? this._historyStore.getSettings().showPanelPercent
            : true;

        const toggleBtn = new St.Button({
            label: showPercent ? 'Ligado' : 'Desligado',
            style_class: showPercent ? 'button toggle-btn-on' : 'button toggle-btn-off',
            can_focus: true,
        });
        toggleBtn.connect('clicked', () => {
            if (this._historyStore) {
                this._historyStore.updateSettings({ showPanelPercent: !showPercent });
            }
            this._updateUI(hasError);
        });
        toggleRow.add_child(toggleBtn);
        this._popupContainer.add_child(toggleRow);

        // Action Bar (Refresh Button & Controls)
        const actionsBar = new St.BoxLayout({
            style_class: 'antigravity-actions-bar',
            x_expand: true,
        });

        const refreshBtn = new St.Button({
            label: '↻ Atualizar Agora',
            style_class: 'button refresh-button',
            x_expand: true,
            can_focus: true,
        });
        refreshBtn.connect('clicked', () => {
            if (this._scheduler) {
                this._scheduler.forceRefresh().catch(() => {});
            }
        });
        actionsBar.add_child(refreshBtn);

        this._popupContainer.add_child(actionsBar);
    }

    /**
     * Creates a St widget card for a quota bucket.
     *
     * @param {object} bucketCard
     * @returns {St.Widget}
     * @private
     */
    _createCardWidget(bucketCard) {
        const card = new St.BoxLayout({
            vertical: true,
            style_class: 'quota-card',
        });

        const titleRow = new St.BoxLayout({ x_expand: true });
        const title = new St.Label({
            text: bucketCard.windowTitle,
            style_class: 'quota-card-title',
            x_expand: true,
        });
        titleRow.add_child(title);

        const remPct = new St.Label({
            text: `${bucketCard.remainingPercentFormatted} rest. (${bucketCard.usedPercentFormatted} usado)`,
            style_class: `quota-card-percent ${bucketCard.health.colorClass}`,
        });
        titleRow.add_child(remPct);
        card.add_child(titleRow);

        // Progress Bar Track
        const track = new St.BoxLayout({
            style_class: 'quota-progress-track',
            x_expand: true,
        });
        const fill = new St.BoxLayout({
            style_class: `quota-progress-${bucketCard.health.level}`,
            x_expand: false,
            width: Math.max(4, Math.round(bucketCard.remainingFraction * 280)),
        });
        track.add_child(fill);
        card.add_child(track);

        // Meta Info Row 1: Reset Countdown & Burn Rate
        const metaRow1 = new St.BoxLayout({ x_expand: true, margin_top: 2 });
        const resetMeta = new St.Label({
            text: bucketCard.resetText,
            style_class: 'quota-card-meta',
            x_expand: true,
        });
        metaRow1.add_child(resetMeta);

        const burnRateMeta = new St.Label({
            text: `Consumo: ${bucketCard.burnRateText}`,
            style_class: 'quota-card-meta',
        });
        metaRow1.add_child(burnRateMeta);
        card.add_child(metaRow1);

        // Meta Info Row 2: Autonomy
        const metaRow2 = new St.BoxLayout({ x_expand: true });
        const autonomyMeta = new St.Label({
            text: `Autonomia: ${bucketCard.autonomyText}`,
            style_class: 'quota-card-meta',
            x_expand: true,
        });
        metaRow2.add_child(autonomyMeta);
        card.add_child(metaRow2);

        return card;
    }
}
