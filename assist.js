const MODULE_NAME = 'ST-ThemeAssist';
const DISPLAY_NAME = 'ThemeAssist';
const extPath = `scripts/extensions/third-party/${MODULE_NAME}`;

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
    // (most recently added first, based on <option> order in #themes).
    if (typeof s.sortMode !== 'string' || !['alpha', 'date'].includes(s.sortMode)) {
        s.sortMode = 'alpha';
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
}


async function waitForPopupAndConfirm() {
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 150));
        const okBtn = document.querySelector('.popup-button-ok');
        if (okBtn) {
            okBtn.click();
            await new Promise(r => setTimeout(r, 300));
            return true;
        }
    }
    return false;
}

async function deleteThemeByName(themeSelect, name, skipConfirm = true) {
    themeSelect.value = name;
    themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    const delBtn = document.getElementById('ui-preset-delete-button');
    if (!delBtn) throw new Error('Delete button not found');
    delBtn.click();
    if (skipConfirm) await waitForPopupAndConfirm();
}

/* ============================================================
 * MAIN INIT
 * ============================================================ */
jQuery(async () => {
    console.log(`[${MODULE_NAME}] Loading...`);
    try {
        const html = await $.get(`${extPath}/assist.html`);

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

        if (getSettings().autoConfirmImport) startAutoConfirmObserver();

        document.addEventListener('ta_auto_import_changed', (e) => {
            if (e.detail && e.detail.enabled) startAutoConfirmObserver();
            else stopAutoConfirmObserver();
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
            if (!autoApplyArmed) return;

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
                toastr.success(`Applied: "${name}"`, DISPLAY_NAME);
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

        renderFavoritesPanel(themeSelect);
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
            toastr.success(`Applied: "${fav}"`, DISPLAY_NAME);
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
                    <div class="ta-folders-wrap">
                        <div class="ta-folders-header">
                            <span class="ta-folders-title">
                                <i class="fa-solid fa-folder"></i>
                                <span>Folders</span>
                            </span>
                            <div class="ta-folders-actions">
                                <div class="menu_button ta-btn ta-btn-small" id="ta_new_folder_btn" title="Create a new folder">
                                    <i class="fa-solid fa-plus"></i>&nbsp;New
                                </div>
                            </div>
                        </div>
                        <div id="ta_folders_list" class="ta-folders-list"></div>
                        <div class="ta-folder-create-row" id="ta_folder_create_row" hidden>
                            <i class="fa-solid fa-folder"></i>
                            <input type="text" class="ta-search-input ta-mini-input" id="ta_new_folder_input"
                                   placeholder="New folder name..." maxlength="64">
                            <div class="menu_button ta-btn ta-btn-small" id="ta_folder_create_confirm" title="Create folder">
                                <i class="fa-solid fa-check"></i>
                            </div>
                            <div class="menu_button ta-btn ta-btn-small" id="ta_folder_create_cancel" title="Cancel">
                                <i class="fa-solid fa-xmark"></i>
                            </div>
                        </div>
                    </div>
                    <div class="ta-list-controls">
                        <span id="ta_stats">${allThemes.length} themes · ${favs.size} favorites</span>
                        <div class="ta-sort-wrap" title="Sort order">
                            <i class="fa-solid fa-arrow-down-wide-short"></i>
                            <select id="ta_sort_mode" class="ta-sort-select">
                                <option value="alpha">A → Z</option>
                                <option value="date">Date added</option>
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

    const $list = overlay.find('#ta_theme_list');
    const $search = overlay.find('#ta_search');
    const $selectAll = overlay.find('#ta_select_all');
    const $skipConfirm = overlay.find('#ta_skip_confirm');
    const $selectedCount = overlay.find('#ta_selected_count');
    const $foldersList = overlay.find('#ta_folders_list');
    const $sortMode = overlay.find('#ta_sort_mode');

    // Date-added index: the order themes appear in the <select> element is the
    // order ST added them, which matches the on-disk sort (alphabetical by
    // filename). For a user-perceivable "date added" we use this order and
    // reverse it so newest is on top.
    const themeOrder = new Map();
    allThemes.forEach((n, i) => themeOrder.set(n, i));

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
                // Most recently added first. Unknown themes go last.
                return (themeOrder.get(b) ?? -1) - (themeOrder.get(a) ?? -1);
            }
            return a.localeCompare(b);
        });

        for (const name of sorted) {
            if (q && !name.toLowerCase().includes(q)) continue;
            const isCurrent = name === currentTheme;
            const isFav = favs.has(name);
            const inFolders = foldersOfTheme(name).length;
            const safeName = escapeHtml(name);
            const row = $(`
                <div class="ta-theme-item ${isCurrent ? 'ta-theme-current' : ''}">
                    <input type="checkbox" class="ta-check">
                    <span class="ta-star ${isFav ? 'ta-star-active' : ''}" title="Toggle favorite"></span>
                    <span class="ta-theme-name">${safeName}</span>
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
                toastr.success(`Applied: "${name}"`, DISPLAY_NAME);
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
                    toastr.success(`Added ${themeNames.length} theme(s) to "${f.name}"`, DISPLAY_NAME);
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
        await bulkDeleteThemes(sel, themeSelect, skip);
    });

    /* ---------- Inline folder creation ----------
       We use an inline row under the folder list instead of a mini-popup
       because mini popups become unreliable on mobile when the main
       Theme Manager uses backdrop-filter. Inline is simpler and works
       everywhere. */
    const $createRow = overlay.find('#ta_folder_create_row');
    const $createInput = overlay.find('#ta_new_folder_input');

    function openFolderCreateRow() {
        $createRow.removeAttr('hidden');
        $createInput.val('');
        // Small delay so iOS reliably opens the keyboard after tap.
        setTimeout(() => { try { $createInput.trigger('focus'); } catch (_) {} }, 30);
    }

    function closeFolderCreateRow() {
        $createRow.attr('hidden', 'hidden');
        $createInput.val('');
    }

    function confirmFolderCreate() {
        const name = $createInput.val().trim();
        if (!name) { toastr.warning('Name cannot be empty', DISPLAY_NAME); return; }
        createFolder(name);
        closeFolderCreateRow();
        renderFolders();
    }

    overlay.find('#ta_new_folder_btn').on('click', () => {
        // Toggle: if it's already open, just refocus the input.
        if ($createRow.is('[hidden]')) openFolderCreateRow();
        else $createInput.trigger('focus');
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

async function bulkDeleteThemes(names, themeSelect, skipConfirm) {
    let ok = 0, fail = 0;
    for (const name of names) {
        try {
            await deleteThemeByName(themeSelect, name, skipConfirm);
            // Also clean the deleted theme out of favorites and folders.
            const favs = getSettings().favorites;
            const fi = favs.indexOf(name);
            if (fi !== -1) { favs.splice(fi, 1); saveSettings(); }
            purgeThemeFromFolders(name);
            await new Promise(r => setTimeout(r, 200));
            ok++;
        } catch (err) {
            console.error(`[${MODULE_NAME}] Delete failed: ${name}`, err);
            fail++;
        }
    }
    toastr.success(`Deleted ${ok}${fail ? `, failed ${fail}` : ''}`, DISPLAY_NAME);
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
    input.addEventListener('change', async (e) => {
        const files = Array.from(input.files);
        if (files.length === 0) return;

        // Flatten zips into json files
        const jsonFiles = [];
        for (const file of files) {
            if (file.name.endsWith('.zip')) {
                const JSZip = await loadJSZip();
                const zipData = await JSZip.loadAsync(file);
                const jsons = Object.keys(zipData.files).filter(f => f.endsWith('.json'));
                for (const jn of jsons) {
                    try {
                        const content = await zipData.files[jn].async('blob');
                        jsonFiles.push(new File([content], jn, { type: 'application/json' }));
                    } catch (err) { console.warn(err); }
                }
            } else if (file.name.endsWith('.json')) {
                jsonFiles.push(file);
            }
        }

        if (jsonFiles.length === 0) { toastr.error('No theme files found', DISPLAY_NAME); return; }
        toastr.info(`Processing ${jsonFiles.length} file(s)...`, DISPLAY_NAME);

        let imported = 0, skipped = 0;
        for (const jf of jsonFiles) {
            try {
                const res = await importThemeWithReplacePrompt(jf, themeSelect);
                if (res) imported++; else skipped++;
                await new Promise(r => setTimeout(r, 400));
            } catch (err) {
                console.error(err);
                skipped++;
            }
        }
        toastr.success(`Imported ${imported}${skipped ? `, skipped ${skipped}` : ''}`, DISPLAY_NAME);
    });
    input.click();
}

function importViaNativeButton(file) {
    return new Promise((resolve, reject) => {
        const importBtn = document.getElementById('ui-preset-import-button');
        if (!importBtn) { reject(new Error('Import button not found')); return; }
        let fileInput = importBtn.querySelector('input[type="file"]');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json';
            fileInput.style.display = 'none';
            importBtn.appendChild(fileInput);
        }
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(resolve, 800);
    });
}

async function importThemeWithReplacePrompt(jsonFile, themeSelect) {
    let presetName = null;
    let freshFile = jsonFile;
    try {
        const text = await jsonFile.text();
        const data = JSON.parse(text);
        presetName = data.presetname || data.name || null;
        freshFile = new File([text], jsonFile.name, { type: jsonFile.type || 'application/json' });
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Cannot parse`, jsonFile.name);
        await importViaNativeButton(jsonFile);
        return true;
    }

    if (!presetName) {
        await importViaNativeButton(freshFile);
        return true;
    }

    const existing = Array.from(themeSelect.options).find(o => o.value === presetName);
    if (!existing) {
        await importViaNativeButton(freshFile);
        toastr.success(`Imported new theme: "${presetName}"`, DISPLAY_NAME);
        return true;
    }

    // Conflict — ask user
    return new Promise((resolve) => {
        const overlay = $(`
            <div id="ta_popup_overlay">
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
                            <div class="menu_button ta-btn" id="ta_repl_cancel">
                                <i class="fa-solid fa-ban"></i>&nbsp;Cancel
                            </div>
                            <div class="menu_button ta-btn ta-btn-danger" id="ta_repl_confirm">
                                <i class="fa-solid fa-trash"></i>&nbsp;Delete
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `);
        $('body').append(overlay);
        const close = () => overlay.remove();
        overlay.find('.ta-close-btn, #ta_repl_cancel').on('click', () => { close(); toastr.info(`Skipped "${presetName}"`, DISPLAY_NAME); resolve(false); });
        overlay.on('click', (e) => { if (e.target === overlay[0]) { close(); resolve(false); } });

        overlay.find('#ta_repl_confirm').on('click', async () => {
            close();
            try {
                await deleteThemeByName(themeSelect, presetName, true);
                await new Promise(r => setTimeout(r, 400));
                await importViaNativeButton(freshFile);
                toastr.success(`Replaced "${presetName}"`, DISPLAY_NAME);
                resolve(true);
            } catch (err) {
                console.error(err);
                toastr.error(`Failed to replace "${presetName}"`, DISPLAY_NAME);
                resolve(false);
            }
        });
    });
}
