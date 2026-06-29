const MODULE_NAME = 'ST-ThemeAssist';
const DISPLAY_NAME = 'ThemeAssist';

/**
 * Resolve the folder this assist.js was actually loaded from, instead of
 * hardcoding `third-party/ST-ThemeAssist`. The extension may be installed
 * under a different folder name (e.g. `ThemeAssist-test`), in which case a
 * hardcoded path makes `$.get(assist.html)` 404 and the whole panel fails
 * to mount. We derive the base path from this script's own <src>.
 */
function resolveExtPath() {
    try {
        // Prefer document.currentScript when available (module top-level).
        const cur = document.currentScript && document.currentScript.src;
        const fromScript = cur || (() => {
            const s = Array.from(document.querySelectorAll('script[src]'))
                .map(el => el.src)
                .find(src => /\/assist\.js(\?|$)/.test(src));
            return s || '';
        })();
        if (fromScript) {
            // Strip the trailing "/assist.js" and make it relative to origin.
            const url = new URL(fromScript, window.location.href);
            const dir = url.pathname.replace(/\/assist\.js.*$/, '');
            // Return a path ST's $.get understands (relative to site root).
            return dir.replace(/^\//, '');
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] resolveExtPath failed, falling back:`, e);
    }
    // Fallback: original default folder name.
    return `scripts/extensions/third-party/${MODULE_NAME}`;
}

const extPath = resolveExtPath();

/* ============================================================
 * MANAGER SKINS (palette)
 * The Theme Manager popup normally inherits its colors from the active
 * SillyTavern theme ('adaptive'). Some ST themes use a transparent tint,
 * which makes the manager hard to read. These fixed skins guarantee a
 * solid, readable surface and let the user pick a look they like.
 * Each skin is just a swatch (for the picker UI) + a CSS attribute hook
 * `[data-ta-skin="<id>"]` defined in assist.css.
 * ============================================================ */
const TA_SKINS = [
    { id: 'adaptive', label: 'Adaptive', swatch: 'var(--ta-accent)' },
    { id: 'amoled',   label: 'AMOLED',   swatch: '#000000' },
    { id: 'dark',     label: 'Dark',     swatch: '#1c1f26' },
    { id: 'blue',     label: 'Blue',     swatch: '#16273f' },
    { id: 'pink',     label: 'Pink',     swatch: '#3a1730' },
    { id: 'dracula',  label: 'Dracula',  swatch: '#282a36' },
    { id: 'nord',     label: 'Nord',     swatch: '#2e3440' },
    { id: 'forest',   label: 'Forest',   swatch: '#16261c' },
    { id: 'light',    label: 'Light',    swatch: '#f3f3f6' },
];
const TA_SKIN_IDS = TA_SKINS.map(s => s.id);

/** Apply the saved manager skin to a popup overlay root element. */
function applyMgrSkin(rootEl) {
    if (!rootEl) return;
    const el = rootEl.jquery ? rootEl[0] : rootEl;
    if (!el) return;
    const skin = getSettings().mgrSkin || 'adaptive';
    el.setAttribute('data-ta-skin', skin);
}

/* ============================================================
 * UTILS
 * ============================================================ */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/** True while a bulk import is running — the auto-apply observer must not
 *  apply every single imported theme one by one. */
let taSuppressAutoApply = false;

/**
 * Controller for the @import auto-confirm observer. The observer watches the
 * whole <body> subtree, which is expensive to keep running all the time (it
 * fires on every chat message, stream token, tooltip, etc.). The @import
 * warning popup only ever appears WHILE a theme is being imported, so we keep
 * the observer off in the background and only switch it on around imports.
 * The init code installs the real start/stop functions here.
 */
const taAutoConfirm = {
    _start: null,
    _stop: null,
    _refs: 0,
    /** Begin watching for the @import popup (ref-counted, nestable). */
    begin() {
        if (this._refs === 0 && typeof this._start === 'function') {
            try { this._start(); } catch (_) { /* not ready */ }
        }
        this._refs++;
    },
    /** Stop watching once all active imports have ended. */
    end() {
        this._refs = Math.max(0, this._refs - 1);
        if (this._refs === 0 && typeof this._stop === 'function') {
            // Let any trailing popup mutation settle before disconnecting.
            setTimeout(() => {
                if (this._refs === 0 && typeof this._stop === 'function') {
                    try { this._stop(); } catch (_) { /* already gone */ }
                }
            }, 1500);
        }
    },
};

/** Returns true if #themes currently has an option with this value. */
function themeOptionExists(themeSelect, name) {
    return Array.from(themeSelect.options).some(o => o.value === name);
}

/** True if any ST popup is currently open and visible (e.g. the @import
 *  warning waiting for the user). Used to pause import timeouts. */
function isAnyStPopupOpen() {
    const popups = document.querySelectorAll('dialog.popup[open], #dialogue_popup');
    for (const p of popups) {
        const r = p.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
    }
    return false;
}

/**
 * Waits until a theme option appears in (or disappears from) #themes.
 * Time spent while an ST popup is open (e.g. the @import confirmation
 * waiting for the user) does NOT count against the timeout.
 * @returns {Promise<boolean>} true if the desired state was reached.
 */
async function waitForThemeOption(themeSelect, name, { present = true, timeoutMs = 6000 } = {}) {
    let waited = 0;
    const step = 120;
    while (waited < timeoutMs) {
        if (themeOptionExists(themeSelect, name) === present) return true;
        await sleep(step);
        // Don't run down the clock while ST is waiting for the user.
        if (!isAnyStPopupOpen()) waited += step;
    }
    return themeOptionExists(themeSelect, name) === present;
}

/* ============================================================
 * SETTINGS STORE
 * ============================================================ */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) extensionSettings[MODULE_NAME] = {};
    const s = extensionSettings[MODULE_NAME];
    if (!Array.isArray(s.favorites)) s.favorites = [];
    if (typeof s.skipConfirm !== 'boolean') s.skipConfirm = true;
    if (typeof s.collapsed !== 'boolean') s.collapsed = true;
    if (typeof s.autoConfirmImport !== 'boolean') s.autoConfirmImport = true;
    // Folders are "soft" tags with a folder-like UI: a theme may belong to
    // any number of folders at the same time.
    if (!Array.isArray(s.folders)) s.folders = [];
    // Sort mode for the theme list: 'alpha' (A→Z, favorites first) or 'date'
    // (most recently added first, based on real timestamps in `themeAddedAt`).
    if (typeof s.sortMode !== 'string' || !['alpha', 'date'].includes(s.sortMode)) {
        s.sortMode = 'alpha';
    }
    // Real "date added" timestamps, keyed by theme name → epoch ms. The order
    // of <option>s in #themes is alphabetical (ST sorts on disk by filename),
    // so it can NOT be used to infer when a theme was added. Instead we record
    // a timestamp the first time we ever see a theme. Themes that existed
    // before this feature get a single shared baseline time so they all sort
    // below anything imported afterwards, while keeping a stable order among
    // themselves (alphabetical, handled by the sort comparator).
    if (!s.themeAddedAt || typeof s.themeAddedAt !== 'object' || Array.isArray(s.themeAddedAt)) {
        s.themeAddedAt = {};
    } else {
        for (const k of Object.keys(s.themeAddedAt)) {
            if (typeof s.themeAddedAt[k] !== 'number' || !isFinite(s.themeAddedAt[k])) {
                delete s.themeAddedAt[k];
            }
        }
    }
    // Set once we've seeded timestamps for the themes that existed before this
    // feature was installed, so the baseline is only applied a single time.
    if (typeof s.themeAddedSeeded !== 'boolean') s.themeAddedSeeded = false;
    // Per-bot themes. When `perBotMode` is on, opening a chat/character that
    // has a bound theme switches to it automatically. Bindings are stored
    // per-bot, keyed by the character's stable `avatar` filename (or by
    // `group:<id>` for group chats), so they survive list re-sorts/reloads.
    if (typeof s.perBotMode !== 'boolean') s.perBotMode = false;
    // Whether the Folders section in the Theme Manager is collapsed.
    if (typeof s.foldersCollapsed !== 'boolean') s.foldersCollapsed = false;
    // Visual skin of the Theme Manager popup itself. 'adaptive' follows the
    // SillyTavern theme (default), the rest are fixed, always-readable skins
    // so the manager never becomes transparent/unreadable.
    if (typeof s.mgrSkin !== 'string' || !TA_SKIN_IDS.includes(s.mgrSkin)) {
        s.mgrSkin = 'adaptive';
    }
    // Whether the "Manager skin" palette section is collapsed (default: yes).
    if (typeof s.skinCollapsed !== 'boolean') s.skinCollapsed = true;
    if (!s.botThemes || typeof s.botThemes !== 'object' || Array.isArray(s.botThemes)) {
        s.botThemes = {};
    } else {
        // Drop any malformed entries (non-string theme names).
        for (const k of Object.keys(s.botThemes)) {
            if (typeof s.botThemes[k] !== 'string' || !s.botThemes[k]) delete s.botThemes[k];
        }
    }
    // Normalize legacy folder shapes in place, without recreating objects,
    // so references taken from previous calls stay valid.
    for (let i = s.folders.length - 1; i >= 0; i--) {
        const f = s.folders[i];
        if (!f || typeof f !== 'object') { s.folders.splice(i, 1); continue; }
        if (typeof f.id !== 'string' || !f.id) f.id = genFolderId();
        if (typeof f.name !== 'string') f.name = 'Folder';
        if (!Array.isArray(f.themes)) f.themes = [];
        else f.themes = f.themes.filter(t => typeof t === 'string');
    }
    return s;
}
function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}
function getFavorites() { return getSettings().favorites; }
function toggleFavorite(themeName) {
    const s = getSettings();
    const idx = s.favorites.indexOf(themeName);
    if (idx === -1) s.favorites.push(themeName);
    else s.favorites.splice(idx, 1);
    saveSettings();
    return idx === -1;
}

/* ============================================================
 * "DATE ADDED" TRACKING
 * ST keeps themes alphabetically on disk, so <option> order tells us
 * nothing about when a theme was added. We persist a real timestamp the
 * first time we ever observe each theme. See getSettings() for details.
 * ============================================================ */

/**
 * Seeds timestamps for themes that already existed before this feature was
 * installed. All pre-existing themes share one baseline time so they sort
 * below anything imported afterwards. Runs at most once.
 * @param {string[]} existingNames Theme names currently in #themes.
 */
function seedThemeTimestamps(existingNames) {
    const s = getSettings();
    if (s.themeAddedSeeded) {
        // Already seeded once. Still backfill any theme we somehow missed
        // (e.g. added while the extension was disabled) with the baseline,
        // so it never floats to the top of "recently added" unexpectedly.
        let changed = false;
        const baseline = s.themeAddedBaseline || 0;
        for (const name of existingNames) {
            if (!(name in s.themeAddedAt)) { s.themeAddedAt[name] = baseline; changed = true; }
        }
        if (changed) saveSettings();
        return;
    }
    const baseline = Date.now();
    s.themeAddedBaseline = baseline;
    for (const name of existingNames) {
        if (!(name in s.themeAddedAt)) s.themeAddedAt[name] = baseline;
    }
    s.themeAddedSeeded = true;
    saveSettings();
}

/**
 * Records "now" as the add time for one or more themes, saving settings at
 * most once. First-seen-wins: existing timestamps are never overwritten. Used
 * in the hot #themes observer where a single import (e.g. a zip) can add
 * dozens of <option>s in one mutation batch.
 */
function markThemesAdded(names, when = Date.now()) {
    if (!names || names.length === 0) return;
    const s = getSettings();
    let changed = false;
    for (const name of names) {
        if (!name || name in s.themeAddedAt) continue; // first-seen wins
        s.themeAddedAt[name] = when;
        changed = true;
    }
    if (changed) saveSettings();
}

/** Returns the recorded add time for a theme, or 0 if unknown. */
function getThemeAddedAt(name) {
    return getSettings().themeAddedAt[name] || 0;
}

/**
 * Human-readable add date for a theme as YYYY-MM-DD (local time).
 * Returns '' when the time is unknown OR is the shared baseline (themes that
 * predate this feature), since we can't honestly date those.
 */
function getThemeAddedDateLabel(name) {
    const s = getSettings();
    const t = s.themeAddedAt[name] || 0;
    if (!t) return '';
    if (s.themeAddedBaseline && t === s.themeAddedBaseline) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Drops a theme's stored add time (call when the theme is deleted). */
function purgeThemeTimestamp(name) {
    const s = getSettings();
    if (name in s.themeAddedAt) {
        delete s.themeAddedAt[name];
        saveSettings();
    }
}

/* ============================================================
 * FOLDERS API
 * Folders are soft, overlapping collections: a single theme can
 * live in any number of folders. Stored as:
 *   { id: string, name: string, themes: string[] }
 * ============================================================ */
function genFolderId() {
    return 'f_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
function getFolders() { return getSettings().folders; }
function getFolderById(id) { return getFolders().find(f => f.id === id) || null; }
function createFolder(name) {
    const s = getSettings();
    const folder = { id: genFolderId(), name: String(name || 'Folder').trim() || 'Folder', themes: [] };
    s.folders.push(folder);
    saveSettings();
    return folder;
}
function deleteFolder(id) {
    const s = getSettings();
    const idx = s.folders.findIndex(f => f.id === id);
    if (idx === -1) return false;
    s.folders.splice(idx, 1);
    saveSettings();
    return true;
}
function renameFolder(id, newName) {
    const f = getFolderById(id);
    if (!f) return false;
    const name = String(newName || '').trim();
    if (!name) return false;
    f.name = name;
    saveSettings();
    return true;
}
/** Toggles a theme in a folder. Returns true if theme is now in folder. */
function toggleThemeInFolder(folderId, themeName) {
    const f = getFolderById(folderId);
    if (!f) return false;
    const idx = f.themes.indexOf(themeName);
    if (idx === -1) f.themes.push(themeName);
    else f.themes.splice(idx, 1);
    saveSettings();
    return idx === -1;
}
/** Adds a theme to a folder (no-op if already there). */
function addThemeToFolder(folderId, themeName) {
    const f = getFolderById(folderId);
    if (!f) return false;
    if (!f.themes.includes(themeName)) {
        f.themes.push(themeName);
        saveSettings();
    }
    return true;
}
/** Remove a theme from ALL folders (e.g. when the theme is deleted). */
function purgeThemeFromFolders(themeName) {
    const s = getSettings();
    let changed = false;
    for (const f of s.folders) {
        const i = f.themes.indexOf(themeName);
        if (i !== -1) { f.themes.splice(i, 1); changed = true; }
    }
    if (changed) saveSettings();
}
/** Returns folder ids that contain themeName. */
function foldersOfTheme(themeName) {
    return getFolders().filter(f => f.themes.includes(themeName)).map(f => f.id);
}

/* ============================================================
 * PER-BOT THEMES API
 * A "bot" is the active single character or the active group. We key
 * bindings by a stable identifier so they survive character-list
 * re-sorts/reloads:
 *   - single character → its `avatar` filename
 *   - group chat       → `group:<group.id>`
 * Bindings live in settings.botThemes: { [botKey]: themeName }.
 * ============================================================ */

/** Whether per-bot auto-switching is currently enabled. */
function isPerBotMode() { return getSettings().perBotMode === true; }

/**
 * Resolves the current "bot" into a stable key + a human-readable label.
 * Reads a FRESH context snapshot every call (getContext() values are
 * captured at call time, not live getters).
 * @returns {{ key: string, label: string } | null} null if no character
 *          or group is active (e.g. welcome screen).
 */
function getCurrentBot() {
    let ctx;
    try { ctx = SillyTavern.getContext(); } catch (_) { return null; }
    if (!ctx) return null;
    // Group chats take precedence — in a group `characterId` is undefined.
    if (ctx.groupId) {
        const group = Array.isArray(ctx.groups)
            ? ctx.groups.find(g => String(g.id) === String(ctx.groupId))
            : null;
        return { key: `group:${ctx.groupId}`, label: group?.name || 'Group' };
    }
    if (ctx.characterId !== undefined && ctx.characterId !== null && Array.isArray(ctx.characters)) {
        const char = ctx.characters[ctx.characterId];
        if (char && typeof char.avatar === 'string' && char.avatar) {
            return { key: char.avatar, label: char.name || char.avatar };
        }
    }
    return null;
}

/** Returns the theme name bound to a bot key, or null. */
function getBoundTheme(botKey) {
    if (!botKey) return null;
    const t = getSettings().botThemes[botKey];
    return (typeof t === 'string' && t) ? t : null;
}

/** Binds (or rebinds) a theme to a bot key. */
function bindThemeToBot(botKey, themeName) {
    if (!botKey || !themeName) return;
    getSettings().botThemes[botKey] = themeName;
    saveSettings();
}

/** Removes any theme binding for a bot key. Returns true if one existed. */
function unbindBot(botKey) {
    const s = getSettings();
    if (Object.prototype.hasOwnProperty.call(s.botThemes, botKey)) {
        delete s.botThemes[botKey];
        saveSettings();
        return true;
    }
    return false;
}

/** Remove a theme from ALL bot bindings (e.g. when the theme is deleted). */
function purgeThemeFromBots(themeName) {
    const s = getSettings();
    let changed = false;
    for (const k of Object.keys(s.botThemes)) {
        if (s.botThemes[k] === themeName) { delete s.botThemes[k]; changed = true; }
    }
    if (changed) saveSettings();
}

/* ============================================================
 * NATIVE THEME ACTIONS (via ST's own buttons)
 * ============================================================ */
function applyThemeByName(themeSelect, name) {
    if (!themeSelect || !name) return;
    // Verify the option actually exists before triggering change, otherwise
    // ST's applyTheme() will no-op silently but we'll have left the select
    // in an invalid state.
    const hasOption = Array.from(themeSelect.options).some(o => o.value === name);
    if (!hasOption) {
        console.warn(`[${MODULE_NAME}] applyThemeByName: option "${name}" not found in #themes`);
        return;
    }
    // Fire ONE change event. Dispatching both a native Event and a jQuery
    // .trigger('change') used to cause ST's handler to run twice, which
    // could race with @import confirmation popups and other async work
    // during theme initialization.
    if ($(themeSelect).hasClass('select2-hidden-accessible')) {
        // select2-managed selects: setting .val + 'change' triggers both
        // select2 internal update and ST's handler.
        $(themeSelect).val(name).trigger('change');
    } else {
        themeSelect.value = name;
        themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // The inline block may not be mounted yet during very early init.
    const lastApplied = document.getElementById('ta_last_applied');
    if (lastApplied) lastApplied.textContent = name;
    // Keep the per-bot bind button's "current theme" hint in sync. Skip during
    // bulk import / bot auto-apply: those rebuild the panel themselves once at
    // the end, so re-rendering on every single applyThemeByName() in a loop is
    // wasted DOM work.
    if (!taSuppressAutoApply && !taSuppressBotApply
        && typeof renderPerBotPanel === 'function'
        && document.getElementById('ta_perbot')) {
        try { renderPerBotPanel(themeSelect); } catch (_) { /* panel not ready */ }
    }
}


/**
 * Waits for an OPEN, VISIBLE ST popup and clicks its OK button.
 * Previously this clicked the first `.popup-button-ok` found anywhere in
 * the document — including buttons inside closed <dialog> templates kept
 * in the DOM — which made bulk deletes confirm the wrong (or no) dialog.
 * @param {(popupEl: Element) => boolean} [match] Optional text predicate.
 */
async function waitForPopupAndConfirm(match = null) {
    for (let i = 0; i < 25; i++) {
        await sleep(120);
        const popups = document.querySelectorAll('dialog.popup[open], #dialogue_popup');
        for (const popup of popups) {
            const pr = popup.getBoundingClientRect();
            if (pr.width === 0 || pr.height === 0) continue;
            if (match && !match(popup)) continue;
            const okBtn = popup.querySelector('.popup-button-ok');
            if (!okBtn) continue;
            const r = okBtn.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            okBtn.click();
            await sleep(250);
            return true;
        }
    }
    return false;
}

async function deleteThemeByName(themeSelect, name, skipConfirm = true) {
    if (!themeOptionExists(themeSelect, name)) {
        throw new Error(`Theme "${name}" not found in #themes`);
    }
    applyThemeByName(themeSelect, name);
    await sleep(350);
    const delBtn = document.getElementById('ui-preset-delete-button');
    if (!delBtn) throw new Error('Delete button not found');
    delBtn.click();
    if (skipConfirm) {
        // Only confirm the actual theme-deletion popup, never an unrelated
        // one. The prompt text is localized (data-i18n), but the quoted
        // theme name is always rendered verbatim — match on either.
        const confirmed = await waitForPopupAndConfirm((p) => {
            const txt = (p.textContent || '');
            return txt.toLowerCase().includes('delete the theme') || txt.includes(`"${name}"`);
        });
        if (!confirmed) throw new Error('Delete confirmation popup not found');
    }
    // Wait for ST to actually remove the option (server roundtrip).
    const gone = await waitForThemeOption(themeSelect, name, { present: false, timeoutMs: 5000 });
    if (!gone) throw new Error(`Theme "${name}" was not removed`);
}

/* ============================================================
 * MAIN INIT
 * ============================================================ */
/** Full inline copy of assist.html, used only if the file can't be fetched. */
function getInlinePanelHtml() {
    return `
<div id="ta_block" class="ta-inline-block ta-collapsed">
    <div class="ta-inline-header" id="ta_toggle_btn" title="Click to expand">
        <i class="fa-solid fa-wand-magic-sparkles"></i>
        <span>ThemeAssist</span>
        <span class="ta-inline-last" title="Last applied theme">
            <span id="ta_last_applied">—</span>
        </span>
        <i class="fa-solid fa-chevron-down ta-chevron"></i>
    </div>
    <div class="ta-inline-body">
        <div class="ta-inline-buttons">
            <div id="ta_theme_manager_btn" class="menu_button ta-btn" title="Open Theme Manager">
                <i class="fa-solid fa-sliders"></i>
            </div>
            <div id="ta_duplicates_btn" class="menu_button ta-btn" title="Smart Import (auto-replace existing)">
                <i class="fa-solid fa-file-import"></i>
            </div>
        </div>
        <div class="ta-inline-favs">
            <div class="ta-inline-favs-title">
                <i class="fa-solid fa-star"></i>
                <span>Favorites</span>
            </div>
            <div id="ta_favorites_list" class="ta-fav-list"></div>
        </div>
    </div>
</div>`;
}

jQuery(async () => {
    console.log(`[${MODULE_NAME}] Loading... (extPath="${extPath}")`);
    try {
        // Try the resolved path first, then a few likely folder names. If ALL
        // fail (e.g. unexpected install folder), fall back to an inline HTML
        // string so the panel still mounts — never let a 404 kill the panel.
        const candidates = [
            `${extPath}/assist.html`,
            `scripts/extensions/third-party/ST-ThemeAssist/assist.html`,
            `scripts/extensions/third-party/ThemeAssist-test/assist.html`,
        ];
        let html = null;
        for (const url of candidates) {
            try { html = await $.get(url); if (html) { console.log(`[${MODULE_NAME}] Loaded HTML from ${url}`); break; } }
            catch (_) { /* try next */ }
        }
        if (!html) {
            console.warn(`[${MODULE_NAME}] assist.html not found via any path — using inline fallback`);
            html = getInlinePanelHtml();
        }

        const themeSelect = document.getElementById('themes');
        const themeBlock = document.getElementById('UI-Theme-Block');

        if (themeSelect) {
            const row = themeSelect.closest('.flex-container') || themeSelect.parentElement;
            $(html).insertAfter(row);
            console.log(`[${MODULE_NAME}] Mounted after #themes`);
        } else if (themeBlock) {
            $(themeBlock).append(html);
        } else {
            $('#extensions_settings2').append(html);
            console.warn(`[${MODULE_NAME}] Fallback mount`);
        }

        // Add the per-bot controls to the bottom of the panel (independent of
        // the assist.html version — works even with a stale cached template).
        ensurePerBotBlock();

        const settings = getSettings();
        // Always start collapsed unless user explicitly expanded last time
        const $block = $('#ta_block');
        $block.addClass('ta-collapsed');
        if (settings.collapsed === false) {
            $block.removeClass('ta-collapsed');
        }

        if (!themeSelect) { console.error(`[${MODULE_NAME}] #themes not found`); return; }

        // Auto-confirm native "@import in Custom CSS" dialog (Yes button).
        //
        // Strategy: watch the whole body subtree for added nodes, but react ONLY
        // when a real ST popup appears whose text contains both "@import" and
        // "Custom CSS" — the exact phrasing of the template (see ST's
        // public/scripts/templates/themeImportWarning.html). This is strict
        // enough to never interfere with other extensions (CSS highlighters,
        // custom editors, etc.) and loose enough to always catch the real
        // warning, regardless of whether the popup node is inserted into body
        // directly or into a nested container.
        let autoConfirmObserver = null;
        // Don't auto-confirm anything during initial page load — wait until
        // ST finished setting up. This avoids racing with any theme-loading
        // UI that might momentarily look like our target popup.
        let autoConfirmArmed = false;
        setTimeout(() => { autoConfirmArmed = true; }, 2500);

        // ST popup selectors (Popup.js uses <dialog class="popup">, older
        // callPopup uses #dialogue_popup). Limit matches to these containers
        // only — never generic classes that other extensions could reuse.
        const ST_POPUP_SEL = 'dialog.popup, #dialogue_popup';

        const isStImportPopup = (popupEl) => {
            if (!popupEl) return false;
            // The real warning uses this exact phrasing from ST's template:
            // "This theme contains @import lines in the Custom CSS.
            //  Press \"Yes\" to proceed."
            // Match on the full phrase rather than loose substrings so we
            // never trip on an arbitrary popup that happens to quote CSS.
            const txt = (popupEl.textContent || '').toLowerCase();
            return txt.includes('@import lines in the custom css');
        };

        const processPopupNode = (popupEl) => {
            if (!autoConfirmArmed) return;
            if (!popupEl || popupEl.dataset.taAutoProcessed) return;
            if (!isStImportPopup(popupEl)) return;
            // The popup must be actually open and visible. ST marks closed
            // popups with various attributes; easiest check is layout box.
            const popupRect = popupEl.getBoundingClientRect();
            if (popupRect.width === 0 || popupRect.height === 0) return;
            const okBtn = popupEl.querySelector('.popup-button-ok');
            if (!okBtn) return;
            const rect = okBtn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            popupEl.dataset.taAutoProcessed = '1';
            console.log(`[${MODULE_NAME}] Auto-confirming @import dialog`);
            setTimeout(() => {
                try {
                    // Double-check at click time — the popup may have been
                    // closed by the user in the meantime.
                    if (!popupEl.isConnected) return;
                    if (okBtn.getBoundingClientRect().width === 0) return;
                    okBtn.click();
                } catch (e) { console.warn(e); }
            }, 80);
        };

        // Retry a popup a few times — ST sometimes inserts the popup node
        // first and fills its text asynchronously, so textContent may be
        // empty on the first mutation. Retries are cheap and stop as soon
        // as the node is processed or proven unrelated.
        const retryProcessPopup = (popupEl) => {
            if (!popupEl || popupEl.dataset.taAutoProcessed) return;
            let attempts = 0;
            const tick = () => {
                if (!popupEl.isConnected) return;
                if (popupEl.dataset.taAutoProcessed) return;
                processPopupNode(popupEl);
                if (popupEl.dataset.taAutoProcessed) return;
                if (++attempts < 10) setTimeout(tick, 60);
            };
            tick();
        };

        const scanForImportPopups = (root) => {
            if (!getSettings().autoConfirmImport) return;
            const scope = root && root.nodeType === 1 ? root : document;
            if (!scope.querySelectorAll) return;
            scope.querySelectorAll(ST_POPUP_SEL).forEach(retryProcessPopup);
        };

        const startAutoConfirmObserver = () => {
            if (autoConfirmObserver) return;
            autoConfirmObserver = new MutationObserver((mutations) => {
                if (!getSettings().autoConfirmImport) return;
                for (const m of mutations) {
                    for (const n of m.addedNodes) {
                        if (n.nodeType !== 1) continue;
                        // Check the node itself…
                        if (n.matches && n.matches(ST_POPUP_SEL)) {
                            retryProcessPopup(n);
                            continue;
                        }
                        // …or any popups inside it (in case of nested insert).
                        if (n.querySelectorAll) {
                            const inner = n.querySelectorAll(ST_POPUP_SEL);
                            if (inner.length) inner.forEach(retryProcessPopup);
                        }
                    }
                }
            });
            // Subtree is required: ST may fill popup content asynchronously,
            // so we need to see insertions deep in the popup structure too.
            // This is safe because we filter strictly by ST_POPUP_SEL.
            autoConfirmObserver.observe(document.body, { childList: true, subtree: true });
            // One-shot scan on start for any popup already open.
            scanForImportPopups(document);
        };

        const stopAutoConfirmObserver = () => {
            if (autoConfirmObserver) {
                autoConfirmObserver.disconnect();
                autoConfirmObserver = null;
            }
        };

        // Expose start/stop to the import flow. The observer is NO LONGER kept
        // running in the background (it watched the whole <body> subtree, which
        // is costly during chat streaming). Instead taAutoConfirm.begin()/end()
        // switch it on only for the duration of an import. The start function
        // itself still respects the user's autoConfirmImport setting.
        taAutoConfirm._start = () => {
            if (!getSettings().autoConfirmImport) return;
            startAutoConfirmObserver();
        };
        taAutoConfirm._stop = stopAutoConfirmObserver;

        // The settings toggle no longer needs to start the observer eagerly —
        // turning it off mid-import should still stop it immediately though.
        document.addEventListener('ta_auto_import_changed', (e) => {
            if (!(e.detail && e.detail.enabled)) stopAutoConfirmObserver();
        });

        // Auto-apply new themes on import.
        //
        // We must be careful here: ST may re-populate #themes during page
        // loading or on settings refresh (e.g. remove old <option>s then
        // add them back). If we treat every addition as an "import" we
        // will apply themes in a loop and can break ST's own
        // initialization, causing a crash that only a reload fixes.
        //
        // Safeguards:
        //  1. A "settled" flag — we ignore all mutations for the first few
        //     seconds after init, long enough for ST to finish populating.
        //  2. Anti-flood — never auto-apply more than one theme per
        //     observer callback, and never more often than every 500ms.
        //  3. Skip if the added <option> was added as part of a
        //     removed+added pair in the same mutation batch (that's a
        //     re-render, not an import).
        let knownThemes = new Set(Array.from(themeSelect.options).map(o => o.value));
        // Establish "date added" baseline for everything that already exists,
        // so genuinely-new imports later get a fresher timestamp and sort on
        // top under "Recently added".
        seedThemeTimestamps([...knownThemes]);
        let autoApplyArmed = false;
        setTimeout(() => { autoApplyArmed = true; }, 4000);
        let lastApplyAt = 0;

        const observer = new MutationObserver((mutations) => {
            // Collect all removals/additions across the batch first so we
            // can detect "swap" patterns (remove X then re-add X).
            const removedInBatch = new Set();
            const addedInBatch = [];
            for (const m of mutations) {
                for (const n of m.removedNodes) {
                    if (n.tagName === 'OPTION' && n.value) {
                        removedInBatch.add(n.value);
                        knownThemes.delete(n.value);
                    }
                }
                for (const n of m.addedNodes) {
                    if (n.tagName === 'OPTION' && n.value) addedInBatch.push(n.value);
                }
            }
            // Update knownThemes for everything we saw added.
            for (const name of addedInBatch) knownThemes.add(name);

            // Record a real "date added" timestamp for genuinely-new themes:
            // added in this batch and NOT a simultaneous re-add of something we
            // just removed (those are re-renders, not imports). Batched so a
            // many-theme import saves settings only once. First-seen-wins, so
            // re-renders of known themes are harmless. Done regardless of
            // `autoApplyArmed` so timestamps are captured during the initial
            // settle window too.
            markThemesAdded(addedInBatch.filter(name => !removedInBatch.has(name)));

            if (!autoApplyArmed) return;
            // During a bulk import our import flow applies the LAST theme
            // itself; auto-applying every intermediate one is noisy and can
            // race with ST's import logic.
            if (taSuppressAutoApply) return;
            if (taSuppressBotApply) return;

            // Only pick truly-new additions: not seen before AND not a
            // simultaneous re-add of something we just "lost".
            const trulyNew = addedInBatch.filter(n => !removedInBatch.has(n));
            if (trulyNew.length === 0) return;

            // Anti-flood: apply at most one theme, and not more often than
            // once per 500ms.
            const now = Date.now();
            if (now - lastApplyAt < 500) return;
            lastApplyAt = now;

            const name = trulyNew[0];
            try {
                applyThemeByName(themeSelect, name);
                toastr.success(`Applied: "${escapeHtml(name)}"`, DISPLAY_NAME);
            } catch (err) {
                console.error(`[${MODULE_NAME}] Auto-apply failed:`, err);
            }
        });
        observer.observe(themeSelect, { childList: true });

        // Collapse toggle
        $('#ta_toggle_btn').on('click', () => {
            $('#ta_block').toggleClass('ta-collapsed');
            getSettings().collapsed = $('#ta_block').hasClass('ta-collapsed');
            saveSettings();
        });

        $('#ta_theme_manager_btn').on('click', (e) => { e.stopPropagation(); openThemeManager(themeSelect); });
        $('#ta_duplicates_btn').on('click', (e) => { e.stopPropagation(); openImportWithReplace(themeSelect); });

        // Let ST's own import button accept multiple files and zips.
        enableNativeMultiImport(themeSelect);

        renderFavoritesPanel(themeSelect);

        // Per-bot themes: wire UI controls and subscribe to chat changes so a
        // bot's bound theme is applied automatically when its chat opens.
        setupPerBotThemes(themeSelect);

        console.log(`[${MODULE_NAME}] Loaded successfully`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to load:`, err);
    }
});

/* ============================================================
 * FAVORITES PANEL
 * ============================================================ */
function renderFavoritesPanel(themeSelect) {
    const favs = getFavorites();
    const container = $('#ta_favorites_list');
    container.empty();
    if (favs.length === 0) {
        container.html('<div class="ta-fav-empty">No favorites yet — add via Theme Manager</div>');
        return;
    }
    for (const fav of favs) {
        const item = $(`
            <div class="ta-fav-item">
                <span class="ta-fav-name">${escapeHtml(fav)}</span>
                <span class="ta-fav-remove" title="Remove"><i class="fa-solid fa-xmark"></i></span>
            </div>
        `);
        item.find('.ta-fav-name').on('click', () => {
            applyThemeByName(themeSelect, fav);
            toastr.success(`Applied: "${escapeHtml(fav)}"`, DISPLAY_NAME);
        });
        item.find('.ta-fav-remove').on('click', (e) => {
            e.stopPropagation();
            toggleFavorite(fav);
            renderFavoritesPanel(themeSelect);
        });
        container.append(item);
    }
}

/* ============================================================
 * PER-BOT THEMES — UI + AUTO-SWITCH
 * ============================================================ */

/**
 * Injects the per-bot controls at the bottom of the inline panel (below the
 * Favorites list). Done from JS so the buttons appear regardless of which
 * assist.html version is loaded. No-op if the block already exists.
 */
function ensurePerBotBlock() {
    if (document.getElementById('ta_perbot')) return;
    const $body = $('#ta_block .ta-inline-body');
    if ($body.length === 0) return;
    $body.append(`
        <div class="ta-inline-favs-title">
            <i class="fa-solid fa-robot"></i>
            <span>Bot themes</span>
        </div>
        <div id="ta_perbot" class="ta-perbot">
            <div class="ta-perbot-modes">
                <div class="ta-mode-btn ta-mode-global" id="ta_mode_global" title="Themes never change automatically">
                    <i class="fa-solid fa-globe"></i><span>Global</span>
                </div>
                <div class="ta-mode-btn ta-mode-perbot" id="ta_mode_perbot" title="Opening a bot's chat applies its linked theme">
                    <i class="fa-solid fa-robot"></i><span>Per-bot</span>
                </div>
            </div>
            <div class="ta-perbot-row">
                <div id="ta_perbot_status" class="ta-perbot-status"></div>
                <div class="ta-perbot-actions">
                    <div id="ta_bind_btn" class="menu_button ta-btn ta-btn-small" title="Link current theme to this bot">
                        <i class="fa-solid fa-link"></i>&nbsp;Link
                    </div>
                    <div id="ta_unbind_btn" class="menu_button ta-btn ta-btn-small ta-btn-danger" title="Unlink theme from this bot" style="display:none">
                        <i class="fa-solid fa-link-slash"></i>
                    </div>
                </div>
            </div>
        </div>`);
}

/** True while we apply a bot's theme programmatically, so the auto-apply
 *  MutationObserver doesn't also fire a toast for it. */
let taSuppressBotApply = false;

/**
 * Applies the theme bound to the currently active bot, if per-bot mode is on
 * and a binding exists. If the bot has no binding, the current theme is left
 * untouched (per design).
 */
function applyBotThemeIfNeeded(themeSelect) {
    if (!isPerBotMode()) return;
    const bot = getCurrentBot();
    if (!bot) return;
    const themeName = getBoundTheme(bot.key);
    if (!themeName) return;                 // no binding → keep current theme
    if (!themeOptionExists(themeSelect, themeName)) {
        console.warn(`[${MODULE_NAME}] Bound theme "${themeName}" for "${bot.label}" no longer exists`);
        return;
    }
    if (themeSelect.value === themeName) return; // already active, nothing to do
    taSuppressBotApply = true;
    try {
        applyThemeByName(themeSelect, themeName);
        toastr.info(`Theme for "${escapeHtml(bot.label)}": "${escapeHtml(themeName)}"`, DISPLAY_NAME);
    } catch (err) {
        console.error(`[${MODULE_NAME}] applyBotThemeIfNeeded failed:`, err);
    } finally {
        // Release on the next tick — the observer fires async after the
        // option/value change.
        setTimeout(() => { taSuppressBotApply = false; }, 600);
    }
}

/**
 * Renders the per-bot controls in the inline panel: the Global/Per-bot mode
 * toggle and the current-bot binding row (bind / unbind / status).
 */
function renderPerBotPanel(themeSelect) {
    const $wrap = $('#ta_perbot');
    if ($wrap.length === 0) return;

    const on = isPerBotMode();
    $('#ta_mode_global').toggleClass('ta-mode-active', !on);
    $('#ta_mode_perbot').toggleClass('ta-mode-active', on);
    $wrap.toggleClass('ta-perbot-on', on);

    const $status = $('#ta_perbot_status');
    const $bindBtn = $('#ta_bind_btn');
    const $unbindBtn = $('#ta_unbind_btn');

    const bot = getCurrentBot();
    if (!bot) {
        $status.html('<span class="ta-perbot-muted">No character selected</span>');
        $bindBtn.addClass('ta-disabled');
        $unbindBtn.hide();
        return;
    }

    const bound = getBoundTheme(bot.key);
    $bindBtn.removeClass('ta-disabled');
    const current = themeSelect.value || '—';

    if (bound) {
        $status.html(
            `<span class="ta-perbot-bot">${escapeHtml(bot.label)}</span>` +
            ` → <span class="ta-perbot-theme" title="Bound theme">${escapeHtml(bound)}</span>`
        );
        $unbindBtn.show();
    } else {
        $status.html(
            `<span class="ta-perbot-bot">${escapeHtml(bot.label)}</span>` +
            ` → <span class="ta-perbot-muted">not linked</span>`
        );
        $unbindBtn.hide();
    }
    // The bind button always binds the CURRENTLY active theme.
    $bindBtn.attr('title', `Link current theme "${current}" to "${bot.label}"`);
}

/**
 * Wires per-bot UI events and subscribes to ST chat/character switches.
 */
function setupPerBotThemes(themeSelect) {
    // --- Mode buttons (Global / Per-bot) ---
    const setMode = (perBot) => {
        getSettings().perBotMode = perBot;
        saveSettings();
        renderPerBotPanel(themeSelect);
        toastr.info(`Mode: ${perBot ? 'Per-bot' : 'Global'}`, DISPLAY_NAME);
        // Switching to Per-bot should immediately honor the current bot's
        // binding (if any).
        if (perBot) applyBotThemeIfNeeded(themeSelect);
    };
    $('#ta_mode_global').on('click', (e) => { e.stopPropagation(); setMode(false); });
    $('#ta_mode_perbot').on('click', (e) => { e.stopPropagation(); setMode(true); });

    $('#ta_bind_btn').on('click', (e) => {
        e.stopPropagation();
        const bot = getCurrentBot();
        if (!bot) { toastr.warning('Open a character or group chat first', DISPLAY_NAME); return; }
        const themeName = themeSelect.value;
        if (!themeName) { toastr.warning('No theme is currently selected', DISPLAY_NAME); return; }
        bindThemeToBot(bot.key, themeName);
        renderPerBotPanel(themeSelect);
        toastr.success(`Linked "${escapeHtml(themeName)}" to "${escapeHtml(bot.label)}"`, DISPLAY_NAME);
    });

    $('#ta_unbind_btn').on('click', (e) => {
        e.stopPropagation();
        const bot = getCurrentBot();
        if (!bot) return;
        if (unbindBot(bot.key)) {
            toastr.info(`Unlinked theme from "${escapeHtml(bot.label)}"`, DISPLAY_NAME);
        }
        renderPerBotPanel(themeSelect);
    });

    // --- React to chat/character switches ---
    try {
        const ctx = SillyTavern.getContext();
        const evt = ctx.eventTypes || ctx.event_types;
        if (ctx.eventSource && evt) {
            const onChange = () => {
                applyBotThemeIfNeeded(themeSelect);
                // Refresh the panel so the binding status reflects the new bot.
                renderPerBotPanel(themeSelect);
            };
            if (evt.CHAT_CHANGED) ctx.eventSource.on(evt.CHAT_CHANGED, onChange);
            if (evt.APP_READY) ctx.eventSource.on(evt.APP_READY, onChange);
        } else {
            console.warn(`[${MODULE_NAME}] eventSource/eventTypes unavailable — per-bot auto-switch disabled`);
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to subscribe to chat events:`, err);
    }

    // Initial paint + honor binding for whatever is open at load.
    renderPerBotPanel(themeSelect);
    applyBotThemeIfNeeded(themeSelect);
}

/* ============================================================
 * THEME MANAGER
 * ============================================================ */
function openThemeManager(themeSelect) {
    const allThemes = Array.from(themeSelect.options).map(o => o.value).filter(Boolean);
    const currentTheme = themeSelect.value;
    const favs = new Set(getFavorites());
    const settings = getSettings();

    const overlay = $(`
        <div id="ta_popup_overlay">
            <div class="ta-popup">
                <div class="ta-popup-header">
                    <h3><i class="fa-solid fa-sliders"></i> Theme Manager</h3>
                    <span class="ta-close-btn"><i class="fa-solid fa-xmark"></i></span>
                </div>
                <div class="ta-popup-body">
                    <div class="ta-search-wrap">
                        <i class="fa-solid fa-magnifying-glass ta-search-icon"></i>
                        <input type="text" class="ta-search-input" id="ta_search" placeholder="Search themes...">
                    </div>
                    <div class="ta-bulk-controls">
                        <label class="ta-check-label">
                            <input type="checkbox" id="ta_select_all">
                            <span>Select All</span>
                        </label>
                        <label class="ta-check-label">
                            <input type="checkbox" id="ta_skip_confirm" ${settings.skipConfirm ? 'checked' : ''}>
                            <span>Skip confirmation</span>
                        </label>
                        <label class="ta-check-label" title="Automatically click Yes on @import CSS warnings">
                            <input type="checkbox" id="ta_auto_import" ${settings.autoConfirmImport ? 'checked' : ''}>
                            <span>Auto-accept @import</span>
                        </label>
                    </div>
                    <div class="ta-skin-bar" id="ta_skin_bar">
                        <div class="ta-skin-title" id="ta_skin_toggle" title="Pick how the Theme Manager itself looks. 'Adaptive' follows your SillyTavern theme; the rest are always-readable.">
                            <i class="fa-solid fa-chevron-down ta-skin-chevron"></i>
                            <i class="fa-solid fa-palette"></i>
                            <span>Manager skin</span>
                            <span class="ta-skin-current" id="ta_skin_current"></span>
                        </div>
                        <div class="ta-skin-collapsible">
                            <div class="ta-skin-swatches" id="ta_skin_swatches"></div>
                        </div>
                    </div>
                    <div class="ta-perbot-bar" id="ta_mgr_perbot">
                        <div class="ta-perbot-modes">
                            <div class="ta-mode-btn" id="ta_mgr_mode_global" title="Themes never change automatically">
                                <i class="fa-solid fa-globe"></i><span>Global</span>
                            </div>
                            <div class="ta-mode-btn" id="ta_mgr_mode_perbot" title="Opening a bot's chat applies its linked theme">
                                <i class="fa-solid fa-robot"></i><span>Per-bot</span>
                            </div>
                        </div>
                        <div class="ta-perbot-bar-info" id="ta_mgr_perbot_info"></div>
                    </div>
                    <div class="ta-folders-wrap" id="ta_folders_wrap">
                        <div class="ta-folders-header">
                            <span class="ta-folders-title" id="ta_folders_toggle" title="Collapse / expand folders">
                                <i class="fa-solid fa-chevron-down ta-folders-chevron"></i>
                                <i class="fa-solid fa-folder"></i>
                                <span>Folders</span>
                            </span>
                            <div class="ta-folders-actions">
                                <div class="menu_button ta-btn ta-btn-small" id="ta_new_folder_btn" title="Create a new folder">
                                    <i class="fa-solid fa-plus"></i>&nbsp;New
                                </div>
                            </div>
                        </div>
                        <div class="ta-folders-collapsible">
                            <div class="ta-folder-create-row" id="ta_folder_create_row" style="display:none">
                                <i class="fa-solid fa-folder"></i>
                                <input type="text" class="ta-search-input" id="ta_new_folder_input"
                                       placeholder="New folder name..." maxlength="64">
                                <div class="menu_button ta-btn ta-btn-small" id="ta_folder_create_confirm" title="Create folder">
                                    <i class="fa-solid fa-check"></i>
                                </div>
                                <div class="menu_button ta-btn ta-btn-small" id="ta_folder_create_cancel" title="Cancel">
                                    <i class="fa-solid fa-xmark"></i>
                                </div>
                            </div>
                            <div id="ta_folders_list" class="ta-folders-list"></div>
                        </div>
                    </div>
                    <div class="ta-list-controls">
                        <span id="ta_stats">${allThemes.length} themes · ${favs.size} favorites</span>
                        <div class="ta-sort-wrap" title="Sort order">
                            <i class="fa-solid fa-arrow-down-wide-short"></i>
                            <select id="ta_sort_mode" class="ta-sort-select">
                                <option value="alpha">A → Z</option>
                                <option value="date">Recently added</option>
                            </select>
                        </div>
                    </div>
                    <div id="ta_theme_list" class="ta-theme-list"></div>
                </div>
                <div class="ta-popup-footer">
                    <div id="ta_selected_count" class="ta-bulk-controls-info">0 selected</div>
                    <div class="ta-footer-buttons">
                        <div class="menu_button ta-btn" id="ta_bulk_folder_btn" title="Add selected themes to a folder">
                            <i class="fa-solid fa-folder-plus"></i>&nbsp;Add to folder
                        </div>
                        <div class="menu_button ta-btn" id="ta_export_btn" title="Export selected themes (zip if multiple)">
                            <i class="fa-solid fa-file-export"></i>&nbsp;Export
                        </div>
                        <div class="menu_button ta-btn ta-btn-danger" id="ta_delete_btn">
                            <i class="fa-solid fa-trash"></i>&nbsp;Delete
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `);
    $('body').append(overlay);
    applyMgrSkin(overlay);

    const $list = overlay.find('#ta_theme_list');
    const $search = overlay.find('#ta_search');
    const $selectAll = overlay.find('#ta_select_all');
    const $skipConfirm = overlay.find('#ta_skip_confirm');
    const $selectedCount = overlay.find('#ta_selected_count');
    const $foldersList = overlay.find('#ta_folders_list');
    const $sortMode = overlay.find('#ta_sort_mode');

    // Make sure every theme currently in the list has a recorded add time.
    // backfills get the shared baseline so they never wrongly jump to the top.
    seedThemeTimestamps(allThemes);

    // Currently active folder filter (null = no filter, show everything).
    let activeFolderId = null;

    $sortMode.val(settings.sortMode);

    function renderFolders() {
        const folders = getFolders();
        $foldersList.empty();
        if (folders.length === 0) {
            $foldersList.html('<div class="ta-folders-empty">No folders yet. Click <b>New</b> to create one.</div>');
            return;
        }
        // Alphabetical sort of folders for stability.
        const sorted = [...folders].sort((a, b) => a.name.localeCompare(b.name));
        for (const folder of sorted) {
            const isActive = folder.id === activeFolderId;
            const count = folder.themes.length;
            const card = $(`
                <div class="ta-folder-card ${isActive ? 'ta-folder-active' : ''}" title="${escapeHtml(folder.name)}">
                    <i class="fa-solid ${isActive ? 'fa-folder-open' : 'fa-folder'} ta-folder-icon"></i>
                    <span class="ta-folder-name">${escapeHtml(folder.name)}</span>
                    <span class="ta-folder-count">${count}</span>
                    <span class="ta-folder-edit" title="Edit folder"><i class="fa-solid fa-pen"></i></span>
                </div>
            `);
            card.on('click', (e) => {
                if ($(e.target).closest('.ta-folder-edit').length) return;
                activeFolderId = isActive ? null : folder.id;
                renderFolders();
                renderList();
            });
            card.find('.ta-folder-edit').on('click', (e) => {
                e.stopPropagation();
                openFolderEditor(folder.id);
            });
            $foldersList.append(card);
        }
    }

    function renderList() {
        const q = $search.val().toLowerCase().trim();
        $list.empty();

        // Current bot + the theme bound to it (if any), for the per-theme
        // link button. Recomputed each render so it tracks chat switches.
        const curBot = getCurrentBot();
        const curBotTheme = curBot ? getBoundTheme(curBot.key) : null;

        // Apply folder filter first (if any).
        let pool = allThemes;
        if (activeFolderId) {
            const f = getFolderById(activeFolderId);
            if (f) {
                const set = new Set(f.themes);
                pool = allThemes.filter(n => set.has(n));
            }
        }

        const mode = settings.sortMode;
        const sorted = [...pool].sort((a, b) => {
            // Favorites always float to the top in both sort modes.
            const af = favs.has(a), bf = favs.has(b);
            if (af !== bf) return af ? -1 : 1;
            if (mode === 'date') {
                // Most recently added first, using real timestamps. Themes
                // sharing the baseline (pre-existing ones) tie and fall back
                // to alphabetical so the order stays stable and predictable.
                const ta = getThemeAddedAt(a), tb = getThemeAddedAt(b);
                if (ta !== tb) return tb - ta;
                return a.localeCompare(b);
            }
            return a.localeCompare(b);
        });

        for (const name of sorted) {
            if (q && !name.toLowerCase().includes(q)) continue;
            const isCurrent = name === currentTheme;
            const isFav = favs.has(name);
            const inFolders = foldersOfTheme(name).length;
            const linkedToBot = curBot && curBotTheme === name;
            const safeName = escapeHtml(name);
            const linkTitle = curBot
                ? (linkedToBot
                    ? `Linked to "${curBot.label}" — click to unlink`
                    : `Link to "${curBot.label}"`)
                : 'Open a chat to link this theme to a bot';
            const addedDate = getThemeAddedDateLabel(name);
            const dateBadge = addedDate
                ? `<span class="ta-theme-date" title="Date added">${addedDate}</span>`
                : '';
            const row = $(`
                <div class="ta-theme-item ${isCurrent ? 'ta-theme-current' : ''}">
                    <input type="checkbox" class="ta-check">
                    <span class="ta-star ${isFav ? 'ta-star-active' : ''}" title="Toggle favorite"></span>
                    <span class="ta-theme-name">${safeName}</span>
                    ${dateBadge}
                    <span class="ta-theme-link ${linkedToBot ? 'ta-theme-link-active' : ''} ${curBot ? '' : 'ta-disabled'}" title="${escapeHtml(linkTitle)}">
                        <i class="fa-solid ${linkedToBot ? 'fa-link' : 'fa-link'}"></i>
                    </span>
                    <span class="ta-theme-folders ${inFolders ? 'ta-theme-folders-active' : ''}" title="Manage folders">
                        <i class="fa-solid fa-folder-plus"></i>${inFolders ? `<span class="ta-theme-folders-count">${inFolders}</span>` : ''}
                    </span>
                </div>
            `);
            row.find('.ta-check').data('theme', name);
            row.find('.ta-star').on('click', (e) => {
                e.stopPropagation();
                const nowFav = toggleFavorite(name);
                if (nowFav) favs.add(name); else favs.delete(name);
                overlay.find('#ta_stats').text(`${allThemes.length} themes · ${favs.size} favorites`);
                renderList();
                renderFavoritesPanel(themeSelect);
            });
            row.find('.ta-theme-name').on('click', () => {
                applyThemeByName(themeSelect, name);
                toastr.success(`Applied: "${escapeHtml(name)}"`, DISPLAY_NAME);
            });
            row.find('.ta-theme-link').on('click', (e) => {
                e.stopPropagation();
                const bot = getCurrentBot();
                if (!bot) { toastr.warning('Open a character or group chat first', DISPLAY_NAME); return; }
                if (getBoundTheme(bot.key) === name) {
                    unbindBot(bot.key);
                    toastr.info(`Unlinked "${escapeHtml(name)}" from "${escapeHtml(bot.label)}"`, DISPLAY_NAME);
                } else {
                    bindThemeToBot(bot.key, name);
                    toastr.success(`Linked "${escapeHtml(name)}" to "${escapeHtml(bot.label)}"`, DISPLAY_NAME);
                }
                renderList();
                renderMgrPerBot();
                renderPerBotPanel(themeSelect);
            });
            row.find('.ta-theme-folders').on('click', (e) => {
                e.stopPropagation();
                openThemeFolderPicker(name);
            });
            row.find('.ta-check').on('change', updateSelectedCount);
            $list.append(row);
        }
        updateSelectedCount();
    }

    function updateSelectedCount() {
        $selectedCount.text(`${overlay.find('.ta-check:checked').length} selected`);
    }

    /* ---------- Folder editor (rename / delete) ----------
       Uses the same overlay+popup structure as the main Theme Manager so
       it behaves identically on mobile. Appended to <body> so it sits in
       its own stacking context above the main manager. */
    function openFolderEditor(folderId) {
        const f = getFolderById(folderId);
        if (!f) return;
        const editor = $(`
            <div class="ta-popup-overlay-extra">
                <div class="ta-popup" style="width:440px">
                    <div class="ta-popup-header">
                        <h3><i class="fa-solid fa-folder"></i> Edit folder</h3>
                        <span class="ta-close-btn"><i class="fa-solid fa-xmark"></i></span>
                    </div>
                    <div class="ta-popup-body">
                        <input type="text" class="ta-search-input" maxlength="64" value="${escapeHtml(f.name)}" style="padding-left:14px">
                        <p style="opacity:0.65;margin-top:10px">${f.themes.length} theme(s) in this folder.</p>
                    </div>
                    <div class="ta-popup-footer">
                        <div class="menu_button ta-btn ta-btn-danger" data-act="del"><i class="fa-solid fa-trash"></i>&nbsp;Delete</div>
                        <div class="ta-footer-buttons">
                            <div class="menu_button ta-btn" data-act="cancel"><i class="fa-solid fa-ban"></i>&nbsp;Cancel</div>
                            <div class="menu_button ta-btn" data-act="save"><i class="fa-solid fa-check"></i>&nbsp;Save</div>
                        </div>
                    </div>
                </div>
            </div>
        `);
        $('body').append(editor);
        applyMgrSkin(editor);
        const $input = editor.find('input[type=text]');
        setTimeout(() => { try { $input.trigger('focus').trigger('select'); } catch (_) {} }, 30);
        const close = () => editor.remove();
        editor.find('.ta-close-btn, [data-act=cancel]').on('click', close);
        editor.on('click', (e) => { if (e.target === editor[0]) close(); });
        editor.find('[data-act=save]').on('click', () => {
            const newName = $input.val().trim();
            if (!newName) { toastr.warning('Name cannot be empty', DISPLAY_NAME); return; }
            renameFolder(folderId, newName);
            close();
            renderFolders();
            renderList();
        });
        editor.find('[data-act=del]').on('click', () => {
            if (!confirm(`Delete folder "${f.name}"? Themes themselves won't be deleted.`)) return;
            deleteFolder(folderId);
            if (activeFolderId === folderId) activeFolderId = null;
            close();
            renderFolders();
            renderList();
        });
        $input.on('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); editor.find('[data-act=save]').trigger('click'); }
            if (e.key === 'Escape') { e.preventDefault(); close(); }
        });
    }

    /* ---------- Theme ↔ folders picker ---------- */
    function openThemeFolderPicker(themeName) {
        const picker = $(`
            <div class="ta-popup-overlay-extra">
                <div class="ta-popup" style="width:440px">
                    <div class="ta-popup-header">
                        <h3><i class="fa-solid fa-folder-plus"></i> Folders for "${escapeHtml(themeName)}"</h3>
                        <span class="ta-close-btn"><i class="fa-solid fa-xmark"></i></span>
                    </div>
                    <div class="ta-popup-body">
                        <div class="ta-folder-checks" id="ta_folder_checks"></div>
                        <div class="ta-folder-create-row" style="margin-top:12px">
                            <i class="fa-solid fa-folder"></i>
                            <input type="text" class="ta-search-input" placeholder="New folder name..." maxlength="64">
                            <div class="menu_button ta-btn ta-btn-small" data-act="create" title="Create folder">
                                <i class="fa-solid fa-plus"></i>
                            </div>
                        </div>
                    </div>
                    <div class="ta-popup-footer">
                        <div></div>
                        <div class="ta-footer-buttons">
                            <div class="menu_button ta-btn" data-act="done"><i class="fa-solid fa-check"></i>&nbsp;Done</div>
                        </div>
                    </div>
                </div>
            </div>
        `);
        $('body').append(picker);
        applyMgrSkin(picker);
        const $checks = picker.find('#ta_folder_checks');

        function renderChecks() {
            $checks.empty();
            const folders = [...getFolders()].sort((a, b) => a.name.localeCompare(b.name));
            if (folders.length === 0) {
                $checks.html('<div class="ta-folders-empty">No folders yet. Create one below.</div>');
                return;
            }
            const inIds = new Set(foldersOfTheme(themeName));
            for (const f of folders) {
                const row = $(`
                    <label class="ta-check-label ta-folder-check-row">
                        <input type="checkbox" ${inIds.has(f.id) ? 'checked' : ''}>
                        <i class="fa-solid fa-folder"></i>
                        <span>${escapeHtml(f.name)}</span>
                    </label>
                `);
                row.find('input').on('change', function () {
                    if (this.checked) addThemeToFolder(f.id, themeName);
                    else {
                        // Explicit remove (toggle would be fine too, but checkbox state is the source of truth).
                        const folder = getFolderById(f.id);
                        if (folder) {
                            const i = folder.themes.indexOf(themeName);
                            if (i !== -1) { folder.themes.splice(i, 1); saveSettings(); }
                        }
                    }
                });
                $checks.append(row);
            }
        }
        renderChecks();

        const close = () => { picker.remove(); renderFolders(); renderList(); };
        picker.find('.ta-close-btn, [data-act=done]').on('click', close);
        picker.on('click', (e) => { if (e.target === picker[0]) close(); });

        picker.find('[data-act=create]').on('click', () => {
            const $input = picker.find('.ta-folder-create-row input[type=text]');
            const name = $input.val().trim();
            if (!name) return;
            const f = createFolder(name);
            addThemeToFolder(f.id, themeName);
            $input.val('');
            renderChecks();
        });
        picker.find('.ta-folder-create-row input[type=text]').on('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); picker.find('[data-act=create]').trigger('click'); }
        });
    }

    /* ---------- Bulk: add selected themes to folder ---------- */
    function openBulkAddToFolder(themeNames) {
        const picker = $(`
            <div class="ta-popup-overlay-extra">
                <div class="ta-popup" style="width:440px">
                    <div class="ta-popup-header">
                        <h3><i class="fa-solid fa-folder-plus"></i> Add ${themeNames.length} theme(s) to folder</h3>
                        <span class="ta-close-btn"><i class="fa-solid fa-xmark"></i></span>
                    </div>
                    <div class="ta-popup-body">
                        <div class="ta-folder-checks" id="ta_bulk_folders"></div>
                        <div class="ta-folder-create-row" style="margin-top:12px">
                            <i class="fa-solid fa-folder"></i>
                            <input type="text" class="ta-search-input" placeholder="New folder name..." maxlength="64">
                            <div class="menu_button ta-btn ta-btn-small" data-act="create" title="Create folder">
                                <i class="fa-solid fa-plus"></i>
                            </div>
                        </div>
                    </div>
                    <div class="ta-popup-footer">
                        <div></div>
                        <div class="ta-footer-buttons">
                            <div class="menu_button ta-btn" data-act="done"><i class="fa-solid fa-check"></i>&nbsp;Done</div>
                        </div>
                    </div>
                </div>
            </div>
        `);
        $('body').append(picker);
        applyMgrSkin(picker);
        const $checks = picker.find('#ta_bulk_folders');

        function draw() {
            $checks.empty();
            const folders = [...getFolders()].sort((a, b) => a.name.localeCompare(b.name));
            if (folders.length === 0) {
                $checks.html('<div class="ta-folders-empty">No folders yet. Create one below.</div>');
                return;
            }
            for (const f of folders) {
                const row = $(`
                    <div class="ta-folder-check-row ta-bulk-row">
                        <i class="fa-solid fa-folder"></i>
                        <span class="ta-bulk-name">${escapeHtml(f.name)}</span>
                        <span class="ta-folder-count">${f.themes.length}</span>
                        <div class="menu_button ta-btn ta-btn-small" data-act="add"><i class="fa-solid fa-plus"></i>&nbsp;Add</div>
                    </div>
                `);
                row.find('[data-act=add]').on('click', () => {
                    for (const n of themeNames) addThemeToFolder(f.id, n);
                    toastr.success(`Added ${themeNames.length} theme(s) to "${escapeHtml(f.name)}"`, DISPLAY_NAME);
                    draw();
                });
                $checks.append(row);
            }
        }
        draw();

        const close = () => { picker.remove(); renderFolders(); renderList(); };
        picker.find('.ta-close-btn, [data-act=done]').on('click', close);
        picker.on('click', (e) => { if (e.target === picker[0]) close(); });

        picker.find('[data-act=create]').on('click', () => {
            const $input = picker.find('.ta-folder-create-row input[type=text]');
            const name = $input.val().trim();
            if (!name) return;
            const f = createFolder(name);
            for (const n of themeNames) addThemeToFolder(f.id, n);
            $input.val('');
            draw();
        });
        picker.find('.ta-folder-create-row input[type=text]').on('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); picker.find('[data-act=create]').trigger('click'); }
        });
    }

    $search.on('input', renderList);
    $selectAll.on('change', () => {
        overlay.find('.ta-check:visible').prop('checked', $selectAll.prop('checked'));
        updateSelectedCount();
    });
    $skipConfirm.on('change', () => {
        settings.skipConfirm = $skipConfirm.prop('checked');
        saveSettings();
    });
    overlay.find('#ta_auto_import').on('change', function () {
        settings.autoConfirmImport = this.checked;
        saveSettings();
        // Notify main init to start/stop its observer
        document.dispatchEvent(new CustomEvent('ta_auto_import_changed', { detail: { enabled: this.checked } }));
        toastr.info(`Auto-accept @import: ${this.checked ? 'ON' : 'OFF'}`, DISPLAY_NAME);
    });
    overlay.find('.ta-close-btn').on('click', () => overlay.remove());
    overlay.on('click', (e) => { if (e.target === overlay[0]) overlay.remove(); });

    overlay.find('#ta_export_btn').on('click', async () => {
        const sel = overlay.find('.ta-check:checked').map((_, el) => $(el).data('theme')).get();
        if (sel.length === 0) { toastr.warning('Select themes to export', DISPLAY_NAME); return; }
        await bulkExportThemes(sel);
    });

    overlay.find('#ta_bulk_folder_btn').on('click', () => {
        const sel = overlay.find('.ta-check:checked').map((_, el) => $(el).data('theme')).get();
        if (sel.length === 0) { toastr.warning('Select themes first', DISPLAY_NAME); return; }
        openBulkAddToFolder(sel);
    });

    overlay.find('#ta_delete_btn').on('click', async () => {
        const sel = overlay.find('.ta-check:checked').map((_, el) => $(el).data('theme')).get();
        if (sel.length === 0) { toastr.warning('Select themes to delete', DISPLAY_NAME); return; }
        const skip = $skipConfirm.prop('checked');
        if (!skip && !confirm(`Delete ${sel.length} theme(s)?`)) return;
        overlay.remove();
        await bulkDeleteThemes(sel, themeSelect);
    });

    /* ---------- Inline folder creation ----------
       We use an inline row under the folder list instead of a mini-popup
       because mini popups become unreliable on mobile when the main
       Theme Manager uses backdrop-filter. Inline is simpler and works
       everywhere. */
    const $createRow = overlay.find('#ta_folder_create_row');
    const $createInput = overlay.find('#ta_new_folder_input');

    function openFolderCreateRow() {
        // Use explicit inline display so no CSS rule can hide it (the HTML
        // [hidden] attribute loses to .ta-folder-create-row { display:flex }
        // at equal specificity, which previously made the row appear to
        // "not open" on some layouts).
        $createRow.css('display', 'flex');
        $createInput.val('');
        // Scroll the row into view in case the body was scrolled and the
        // inline row sits outside the visible area (especially on mobile,
        // where the popup body is short and the folder list can be long).
        try {
            $createRow[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (_) { /* older browsers */ }
        // Small delay so iOS reliably opens the keyboard after tap.
        setTimeout(() => { try { $createInput.trigger('focus'); } catch (_) {} }, 80);
    }

    function closeFolderCreateRow() {
        $createRow.css('display', 'none');
        $createInput.val('');
    }

    function confirmFolderCreate() {
        const name = $createInput.val().trim();
        if (!name) { toastr.warning('Name cannot be empty', DISPLAY_NAME); return; }
        createFolder(name);
        closeFolderCreateRow();
        renderFolders();
    }

    // Collapse / expand the Folders section to save vertical space.
    const $foldersWrap = overlay.find('#ta_folders_wrap');
    function applyFoldersCollapsed() {
        $foldersWrap.toggleClass('ta-folders-collapsed', settings.foldersCollapsed === true);
    }
    overlay.find('#ta_folders_toggle').on('click', () => {
        settings.foldersCollapsed = !settings.foldersCollapsed;
        saveSettings();
        applyFoldersCollapsed();
    });
    applyFoldersCollapsed();

    overlay.find('#ta_new_folder_btn').on('click', () => {
        // Expanding via creating a folder makes no sense while collapsed —
        // expand the section first so the input is visible.
        if (settings.foldersCollapsed) {
            settings.foldersCollapsed = false;
            saveSettings();
            applyFoldersCollapsed();
        }
        // Toggle: if already open, just refocus the input.
        if ($createRow.is(':visible')) $createInput.trigger('focus');
        else openFolderCreateRow();
    });
    overlay.find('#ta_folder_create_confirm').on('click', confirmFolderCreate);
    overlay.find('#ta_folder_create_cancel').on('click', closeFolderCreateRow);
    $createInput.on('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmFolderCreate(); }
        if (e.key === 'Escape') { e.preventDefault(); closeFolderCreateRow(); }
    });

    $sortMode.on('change', () => {
        settings.sortMode = $sortMode.val();
        saveSettings();
        renderList();
    });

    /* ---------- Per-bot bar inside the manager ---------- */
    function renderMgrPerBot() {
        const on = isPerBotMode();
        overlay.find('#ta_mgr_mode_global').toggleClass('ta-mode-active', !on);
        overlay.find('#ta_mgr_mode_perbot').toggleClass('ta-mode-active', on);
        const bot = getCurrentBot();
        const $info = overlay.find('#ta_mgr_perbot_info');
        if (!bot) {
            $info.html('<span class="ta-perbot-muted">No character selected — open a chat to link themes</span>');
            return;
        }
        const bound = getBoundTheme(bot.key);
        if (bound) {
            $info.html(
                `<i class="fa-solid fa-link"></i> <span class="ta-perbot-bot">${escapeHtml(bot.label)}</span>` +
                ` → <span class="ta-perbot-theme">${escapeHtml(bound)}</span>`
            );
        } else {
            $info.html(
                `<span class="ta-perbot-bot">${escapeHtml(bot.label)}</span>` +
                ` → <span class="ta-perbot-muted">not linked (use the <i class="fa-solid fa-link"></i> on a theme)</span>`
            );
        }
    }
    overlay.find('#ta_mgr_mode_global').on('click', () => {
        settings.perBotMode = false; saveSettings();
        renderMgrPerBot(); renderList(); renderPerBotPanel(themeSelect);
        toastr.info('Mode: Global', DISPLAY_NAME);
    });
    overlay.find('#ta_mgr_mode_perbot').on('click', () => {
        settings.perBotMode = true; saveSettings();
        renderMgrPerBot(); renderList(); renderPerBotPanel(themeSelect);
        toastr.info('Mode: Per-bot', DISPLAY_NAME);
        applyBotThemeIfNeeded(themeSelect);
    });

    /* ---------- Manager skin (palette) ---------- */
    const $skinBar = overlay.find('#ta_skin_bar');
    const $skinSwatches = overlay.find('#ta_skin_swatches');
    const $skinCurrent = overlay.find('#ta_skin_current');

    function applySkinCollapsed() {
        $skinBar.toggleClass('ta-skin-collapsed', getSettings().skinCollapsed === true);
    }
    overlay.find('#ta_skin_toggle').on('click', () => {
        const s = getSettings();
        s.skinCollapsed = !s.skinCollapsed;
        saveSettings();
        applySkinCollapsed();
    });

    function renderSkinSwatches() {
        $skinSwatches.empty();
        const cur = getSettings().mgrSkin || 'adaptive';
        const curLabel = (TA_SKINS.find(s => s.id === cur) || {}).label || cur;
        $skinCurrent.text(curLabel);
        for (const skin of TA_SKINS) {
            const active = skin.id === cur;
            // Adaptive's dot should reflect the live theme accent, so it uses
            // a CSS class (tied to --SmartThemeQuoteColor) instead of an inline
            // color that would otherwise follow the selected skin's accent.
            const dot = skin.id === 'adaptive'
                ? '<span class="ta-skin-dot ta-skin-dot-adaptive"></span>'
                : `<span class="ta-skin-dot" style="background:${skin.swatch}"></span>`;
            const sw = $(`
                <div class="ta-skin-swatch ${active ? 'ta-skin-active' : ''}" title="${escapeHtml(skin.label)}" data-skin="${skin.id}">
                    ${dot}
                    <span class="ta-skin-label">${escapeHtml(skin.label)}</span>
                </div>
            `);
            sw.on('click', () => {
                const s = getSettings();
                s.mgrSkin = skin.id;
                saveSettings();
                // Re-skin the main manager and any stacked extra popups live.
                applyMgrSkin(overlay);
                document.querySelectorAll('.ta-popup-overlay-extra')
                    .forEach(el => el.setAttribute('data-ta-skin', skin.id));
                renderSkinSwatches();
            });
            $skinSwatches.append(sw);
        }
    }
    renderSkinSwatches();
    applySkinCollapsed();

    renderMgrPerBot();
    renderFolders();
    renderList();
}

/* ============================================================
 * ZIP LIB LOADER (for Smart Import / Export)
 * ============================================================ */
async function loadJSZip() {
    if (window.JSZip) return window.JSZip;
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        s.onload = () => resolve(window.JSZip);
        s.onerror = () => reject(new Error('JSZip load failed'));
        document.head.appendChild(s);
    });
}

/* ============================================================
 * EXPORT THEMES
 * ============================================================ */

/**
 * Fetches the full theme objects from ST's server.
 * /api/settings/get returns ALL user settings including the themes array.
 * @returns {Promise<Array<object>>} Array of theme objects, or [] on failure.
 */
async function fetchAllThemes() {
    try {
        const ctx = SillyTavern.getContext();
        const headers = (typeof ctx.getRequestHeaders === 'function')
            ? ctx.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const res = await fetch('/api/settings/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data.themes) ? data.themes : [];
    } catch (err) {
        console.error(`[${MODULE_NAME}] fetchAllThemes failed:`, err);
        toastr.error('Failed to fetch themes from server', DISPLAY_NAME);
        return [];
    }
}

/** Safe filename from theme name. */
function themeFileName(name) {
    return String(name || 'theme')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || 'theme';
}

/** Triggers a browser download of a Blob. */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}

/**
 * Exports selected themes:
 *  - 1 theme  → single .json file
 *  - 2+ themes → a zip archive
 * @param {string[]} names Theme names to export.
 */
async function bulkExportThemes(names) {
    if (!Array.isArray(names) || names.length === 0) {
        toastr.warning('Nothing to export', DISPLAY_NAME);
        return;
    }

    toastr.info(`Preparing export of ${names.length} theme(s)...`, DISPLAY_NAME);
    const allThemes = await fetchAllThemes();
    if (allThemes.length === 0) return;

    const byName = new Map(allThemes.map(t => [t.name, t]));
    const found = [];
    const missing = [];
    for (const n of names) {
        if (byName.has(n)) found.push(byName.get(n));
        else missing.push(n);
    }

    if (found.length === 0) {
        toastr.error('Selected themes not found on server', DISPLAY_NAME);
        return;
    }

    try {
        if (found.length === 1) {
            const theme = found[0];
            const blob = new Blob([JSON.stringify(theme, null, 4)], { type: 'application/json' });
            downloadBlob(blob, `${themeFileName(theme.name)}.json`);
        } else {
            const JSZip = await loadJSZip();
            const zip = new JSZip();
            const usedNames = new Set();
            for (const theme of found) {
                // Make sure filenames inside the zip are unique even if two
                // themes share a sanitized name.
                let base = themeFileName(theme.name);
                let fname = `${base}.json`;
                let i = 2;
                while (usedNames.has(fname)) {
                    fname = `${base} (${i++}).json`;
                }
                usedNames.add(fname);
                zip.file(fname, JSON.stringify(theme, null, 4));
            }
            const blob = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 6 },
            });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            downloadBlob(blob, `themes-export-${stamp}.zip`);
        }

        const missed = missing.length ? `, ${missing.length} missing` : '';
        toastr.success(`Exported ${found.length} theme(s)${missed}`, DISPLAY_NAME);
        if (missing.length) {
            console.warn(`[${MODULE_NAME}] Missing themes:`, missing);
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] Export failed:`, err);
        toastr.error('Export failed — see console', DISPLAY_NAME);
    }
}

async function bulkDeleteThemes(names, themeSelect) {
    let ok = 0, fail = 0;
    for (const name of names) {
        try {
            // Always auto-confirm ST's per-theme popup here: the user already
            // confirmed the whole batch in the Theme Manager. Passing the
            // 'skip confirmation' checkbox through (as before) meant that
            // with the checkbox off, ST's popup stayed open while the loop
            // raced ahead to the next theme.
            await deleteThemeByName(themeSelect, name, true);
            // Also clean the deleted theme out of favorites and folders.
            const favs = getSettings().favorites;
            const fi = favs.indexOf(name);
            if (fi !== -1) { favs.splice(fi, 1); saveSettings(); }
            purgeThemeFromFolders(name);
            purgeThemeFromBots(name);
            purgeThemeTimestamp(name);
            await sleep(150);
            ok++;
        } catch (err) {
            console.error(`[${MODULE_NAME}] Delete failed: ${name}`, err);
            fail++;
        }
    }
    if (fail) toastr.warning(`Deleted ${ok}, failed ${fail}`, DISPLAY_NAME);
    else toastr.success(`Deleted ${ok}`, DISPLAY_NAME);
    renderFavoritesPanel(themeSelect);
}

/* ============================================================
 * IMPORT WITH REPLACE (smart)
 * ============================================================ */
function openImportWithReplace(themeSelect) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.zip';
    input.multiple = true;
    input.addEventListener('change', async () => {
        const files = Array.from(input.files);
        if (files.length === 0) return;
        await runBulkImport(files, themeSelect);
    });
    input.click();
}

/**
 * Expands a mixed list of .json/.zip files into a flat list of theme JSON
 * File objects. Zip entries that are directories, hidden files or macOS
 * metadata (__MACOSX/, .DS_Store, ._*) are skipped.
 * @param {File[]} files
 * @returns {Promise<File[]>}
 */
async function expandThemeFiles(files) {
    const jsonFiles = [];
    for (const file of files) {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.zip')) {
            try {
                const JSZip = await loadJSZip();
                const zipData = await JSZip.loadAsync(file);
                for (const [path, entry] of Object.entries(zipData.files)) {
                    if (entry.dir) continue;
                    if (!path.toLowerCase().endsWith('.json')) continue;
                    const base = path.split('/').pop();
                    if (path.startsWith('__MACOSX/') || base.startsWith('._') || base.startsWith('.')) continue;
                    try {
                        const content = await entry.async('blob');
                        jsonFiles.push(new File([content], base, { type: 'application/json' }));
                    } catch (err) { console.warn(`[${MODULE_NAME}] Failed to read zip entry ${path}`, err); }
                }
            } catch (err) {
                console.error(`[${MODULE_NAME}] Failed to open zip ${file.name}`, err);
                toastr.error(`Cannot open zip: ${escapeHtml(file.name)}`, DISPLAY_NAME);
            }
        } else if (lower.endsWith('.json')) {
            jsonFiles.push(file);
        }
    }
    return jsonFiles;
}

/**
 * Imports many theme files sequentially through ST's native pipeline,
 * prompting per conflict. While the batch runs, the auto-apply observer is
 * suppressed; the last successfully imported theme is applied at the end.
 * @param {File[]} files Raw user-picked files (.json and/or .zip).
 * @param {HTMLSelectElement} themeSelect
 */
async function runBulkImport(files, themeSelect) {
    const jsonFiles = await expandThemeFiles(files);
    if (jsonFiles.length === 0) { toastr.error('No theme files found', DISPLAY_NAME); return; }
    toastr.info(`Processing ${jsonFiles.length} file(s)...`, DISPLAY_NAME);

    taSuppressAutoApply = true;
    taAutoConfirm.begin(); // watch for @import popups only during this import
    let imported = 0, skipped = 0;
    let lastImportedName = null;
    try {
        for (const jf of jsonFiles) {
            try {
                const res = await importThemeWithReplacePrompt(jf, themeSelect);
                if (res && res.ok) {
                    imported++;
                    if (res.name) lastImportedName = res.name;
                } else {
                    skipped++;
                }
                await sleep(250);
            } catch (err) {
                console.error(`[${MODULE_NAME}] Import failed for ${jf.name}:`, err);
                skipped++;
            }
        }
    } finally {
        taSuppressAutoApply = false;
        taAutoConfirm.end();
    }

    if (lastImportedName && themeOptionExists(themeSelect, lastImportedName)) {
        try {
            applyThemeByName(themeSelect, lastImportedName);
        } catch (err) { console.warn(`[${MODULE_NAME}] Auto-apply after import failed:`, err); }
    }
    const msg = `Imported ${imported}${skipped ? `, skipped ${skipped}` : ''}`;
    if (imported > 0) toastr.success(msg, DISPLAY_NAME);
    else toastr.warning(msg, DISPLAY_NAME);
}

/**
 * Upgrades ST's native theme import input (#ui_preset_import_file) to accept
 * multiple files and zip archives. When the user picks exactly one .json we
 * step aside and let ST's own handler run untouched; for multiple files or
 * zips we intercept (capture phase, before ST's listener) and run our bulk
 * pipeline instead — so character-card-style multi-import now works for
 * themes too.
 */
function enableNativeMultiImport(themeSelect) {
    const fileInput = document.getElementById('ui_preset_import_file');
    if (!fileInput) {
        console.warn(`[${MODULE_NAME}] #ui_preset_import_file not found — native multi-import disabled`);
        return;
    }
    fileInput.setAttribute('multiple', '');
    // Allow zips in the picker as well.
    fileInput.setAttribute('accept', '.json,.zip');
    // IMPORTANT: the intercept listener must run BEFORE ST's own jQuery
    // 'change' handler on the input. Capture listeners on the input itself
    // would NOT help — at the target element listeners fire in registration
    // order regardless of the capture flag, and ST registered first. A
    // capture listener on an ANCESTOR (document) however always runs before
    // any listener on the target.
    document.addEventListener('change', (e) => {
        if (e.target !== fileInput) return;
        const files = Array.from(fileInput.files || []);
        const needsIntercept = files.length > 1
            || files.some(f => f.name.toLowerCase().endsWith('.zip'));
        if (!needsIntercept) {
            // Single .json → ST handles it natively. Open a brief window for
            // the @import auto-confirm observer to catch ST's warning popup,
            // then let it switch back off.
            if (files.length === 1) {
                taAutoConfirm.begin();
                setTimeout(() => taAutoConfirm.end(), 8000);
            }
            return;
        }
        // Stop ST's own handler (it only reads files[0] and would double-import).
        e.stopImmediatePropagation();
        e.preventDefault();
        // Clear the input like ST's finally{} does, so re-picking the same
        // files fires change again.
        const picked = files.slice();
        fileInput.value = '';
        runBulkImport(picked, themeSelect);
    }, true);
}

/**
 * Feeds a single theme .json file into ST's own import pipeline by setting
 * the files of ST's native hidden input (#ui_preset_import_file) and firing
 * its change handler.
 *
 * BUGFIX: this used to look for `#ui-preset-import-button` (with dashes) and
 * append its own <input> inside it. ST's real elements are
 * `#ui_preset_import_button` / `#ui_preset_import_file` (underscores), so
 * the lookup always failed and Smart Import was broken. We now target the
 * real input directly, with the old approach kept only as a fallback for
 * forks that renamed it.
 *
 * @param {File} file Theme JSON file.
 * @param {HTMLSelectElement|null} themeSelect If given (with expectName), we
 *        wait until the option actually appears instead of a blind delay.
 * @param {string|null} expectName Theme name expected to appear in #themes.
 * @returns {Promise<boolean>} true if import was confirmed (option appeared)
 *          or could not be verified; rejects only on infra errors.
 */
async function importViaNativeButton(file, themeSelect = null, expectName = null) {
    let fileInput = document.getElementById('ui_preset_import_file');
    if (!fileInput) {
        // Fallback for forks: any file input near the import button.
        const importBtn = document.getElementById('ui_preset_import_button')
            || document.getElementById('ui-preset-import-button');
        if (importBtn) {
            fileInput = importBtn.querySelector('input[type="file"]')
                || importBtn.parentElement?.querySelector('input[type="file"]')
                || null;
        }
    }
    if (!fileInput) throw new Error('Native theme import input not found');

    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    if (themeSelect && expectName) {
        // ST shows the @import warning popup before adding the option; the
        // waiter ignores time spent while a popup is open, so manual
        // confirmation doesn't cause a false negative.
        return await waitForThemeOption(themeSelect, expectName, { present: true, timeoutMs: 8000 });
    }
    await sleep(800);
    return true;
}

/**
 * Imports one theme JSON, prompting if a theme with the same name already
 * exists (ST itself refuses to overwrite).
 * @returns {Promise<{ok: boolean, name: string|null}>}
 */
async function importThemeWithReplacePrompt(jsonFile, themeSelect) {
    let presetName = null;
    let freshFile = jsonFile;
    try {
        const text = await jsonFile.text();
        const data = JSON.parse(text);
        // ST's importTheme() keys EXCLUSIVELY on `parsed.name` (and throws
        // if it's missing). Checking `presetname` first could compare the
        // wrong key and miss a genuine conflict.
        presetName = (typeof data.name === 'string' && data.name) ? data.name : null;
        freshFile = new File([text], jsonFile.name, { type: jsonFile.type || 'application/json' });
    } catch (err) {
        // ST's importTheme() does JSON.parse(fileText) and would throw too.
        // Don't feed it garbage and don't count it as imported.
        console.warn(`[${MODULE_NAME}] Cannot parse ${jsonFile.name}:`, err);
        toastr.error(`Not a valid theme JSON: ${escapeHtml(jsonFile.name)}`, DISPLAY_NAME);
        return { ok: false, name: null };
    }

    if (!presetName) {
        // ST throws 'Missing name' for such files.
        console.warn(`[${MODULE_NAME}] ${jsonFile.name} has no "name" field`);
        toastr.error(`Theme file has no name: ${escapeHtml(jsonFile.name)}`, DISPLAY_NAME);
        return { ok: false, name: null };
    }

    if (!themeOptionExists(themeSelect, presetName)) {
        const ok = await importViaNativeButton(freshFile, themeSelect, presetName);
        if (ok) toastr.success(`Imported: "${escapeHtml(presetName)}"`, DISPLAY_NAME);
        else toastr.error(`Import failed: "${escapeHtml(presetName)}"`, DISPLAY_NAME);
        return { ok, name: ok ? presetName : null };
    }

    // Conflict — ask user. NOTE: class instead of id (the main Theme Manager
    // also uses #ta_popup_overlay; duplicate ids broke its CSS/queries when
    // both were open at once).
    return new Promise((resolve) => {
        const overlay = $(`
            <div class="ta-popup-overlay-extra">
                <div class="ta-popup" style="width:440px">
                    <div class="ta-popup-header">
                        <h3><i class="fa-solid fa-triangle-exclamation"></i> Theme already exists</h3>
                        <span class="ta-close-btn"><i class="fa-solid fa-xmark"></i></span>
                    </div>
                    <div class="ta-popup-body">
                        <p>Theme <b>"${escapeHtml(presetName)}"</b> already exists in your library.</p>
                        <p style="opacity:0.7">Delete the old one and import the new JSON?</p>
                    </div>
                    <div class="ta-popup-footer">
                        <div></div>
                        <div class="ta-footer-buttons">
                            <div class="menu_button ta-btn" data-act="cancel">
                                <i class="fa-solid fa-ban"></i>&nbsp;Skip
                            </div>
                            <div class="menu_button ta-btn ta-btn-danger" data-act="replace">
                                <i class="fa-solid fa-trash"></i>&nbsp;Replace
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `);
        $('body').append(overlay);
        applyMgrSkin(overlay);
        const close = () => overlay.remove();
        overlay.find('.ta-close-btn, [data-act=cancel]').on('click', () => {
            close();
            toastr.info(`Skipped "${escapeHtml(presetName)}"`, DISPLAY_NAME);
            resolve({ ok: false, name: null });
        });
        overlay.on('click', (e) => {
            if (e.target === overlay[0]) { close(); resolve({ ok: false, name: null }); }
        });

        overlay.find('[data-act=replace]').on('click', async () => {
            close();
            try {
                await deleteThemeByName(themeSelect, presetName, true);
                const ok = await importViaNativeButton(freshFile, themeSelect, presetName);
                if (!ok) throw new Error('re-import did not complete');
                toastr.success(`Replaced "${escapeHtml(presetName)}"`, DISPLAY_NAME);
                resolve({ ok: true, name: presetName });
            } catch (err) {
                console.error(`[${MODULE_NAME}] Replace failed for "${presetName}":`, err);
                toastr.error(`Failed to replace "${escapeHtml(presetName)}"`, DISPLAY_NAME);
                resolve({ ok: false, name: null });
            }
        });
    });
}
