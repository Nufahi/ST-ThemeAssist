const MODULE_NAME = 'ST-ThemeAssist';
const DISPLAY_NAME = 'ThemeAssist';
const extPath = `scripts/extensions/third-party/${MODULE_NAME}`;

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
 * NATIVE THEME ACTIONS (via ST's own buttons)
 * ============================================================ */
function applyThemeByName(themeSelect, name) {
    themeSelect.value = name;
    themeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    if ($(themeSelect).hasClass('select2-hidden-accessible')) {
        $(themeSelect).val(name).trigger('change.select2');
    } else {
        $(themeSelect).trigger('change');
    }
    $('#ta_last_applied').text(name);
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

        // Auto-confirm native "@import in Custom CSS" dialog (Yes button)
        const tryAutoConfirm = () => {
            if (!getSettings().autoConfirmImport) return;
            // Global search: find any visible Yes button whose popup mentions @import
            const yesButtons = document.querySelectorAll('.popup-button-ok.result-control, .popup-button-ok');
            for (const btn of yesButtons) {
                if (btn.dataset.taAutoClicked) continue;
                // Check visibility
                const rect = btn.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                // Walk up to find the popup container and check text
                let parent = btn.closest('dialog, .popup, .dialogue_popup, .popup-content, body');
                if (!parent) parent = document.body;
                const txt = (parent.textContent || '').toLowerCase();
                if (!txt.includes('@import')) continue;

                btn.dataset.taAutoClicked = '1';
                console.log(`[${MODULE_NAME}] Auto-confirming @import dialog`);
                setTimeout(() => {
                    btn.click();
                    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }, 80);
            }
        };

        const autoConfirmObserver = new MutationObserver(tryAutoConfirm);
        autoConfirmObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

        // Also poll every 500ms as a safety net (in case observer misses something)
        setInterval(tryAutoConfirm, 500);

        // Auto-apply new themes on import
        let knownThemes = new Set(Array.from(themeSelect.options).map(o => o.value));
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const n of m.removedNodes) {
                    if (n.tagName === 'OPTION' && knownThemes.has(n.value)) knownThemes.delete(n.value);
                }
                for (const n of m.addedNodes) {
                    if (n.tagName === 'OPTION' && !knownThemes.has(n.value)) {
                        const name = n.value;
                        applyThemeByName(themeSelect, name);
                        knownThemes.add(name);
                        toastr.success(`Applied: "${name}"`, DISPLAY_NAME);
                    }
                }
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
                <span class="ta-fav-name">${fav}</span>
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
                    <div class="ta-bulk-controls-info">
                        <span id="ta_stats">${allThemes.length} themes · ${favs.size} favorites</span>
                    </div>
                    <div id="ta_theme_list" class="ta-theme-list"></div>
                </div>
                <div class="ta-popup-footer">
                    <div id="ta_selected_count" class="ta-bulk-controls-info">0 selected</div>
                    <div class="ta-footer-buttons">
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

    function renderList() {
        const q = $search.val().toLowerCase().trim();
        $list.empty();
        const sorted = [...allThemes].sort((a, b) => {
            const af = favs.has(a), bf = favs.has(b);
            if (af !== bf) return af ? -1 : 1;
            return a.localeCompare(b);
        });
        for (const name of sorted) {
            if (q && !name.toLowerCase().includes(q)) continue;
            const isCurrent = name === currentTheme;
            const isFav = favs.has(name);
            const row = $(`
                <div class="ta-theme-item ${isCurrent ? 'ta-theme-current' : ''}">
                    <input type="checkbox" class="ta-check" data-theme="${name}">
                    <span class="ta-star ${isFav ? 'ta-star-active' : ''}" title="Toggle favorite"></span>
                    <span class="ta-theme-name">${name}</span>
                </div>
            `);
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
            row.find('.ta-check').on('change', updateSelectedCount);
            $list.append(row);
        }
        updateSelectedCount();
    }

    function updateSelectedCount() {
        $selectedCount.text(`${overlay.find('.ta-check:checked').length} selected`);
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
        toastr.info(`Auto-accept @import: ${this.checked ? 'ON' : 'OFF'}`, DISPLAY_NAME);
    });
    overlay.find('.ta-close-btn').on('click', () => overlay.remove());
    overlay.on('click', (e) => { if (e.target === overlay[0]) overlay.remove(); });

        overlay.find('#ta_delete_btn').on('click', async () => {
        const sel = overlay.find('.ta-check:checked').map((_, el) => $(el).data('theme')).get();
        if (sel.length === 0) { toastr.warning('Select themes to delete', DISPLAY_NAME); return; }
        const skip = $skipConfirm.prop('checked');
        if (!skip && !confirm(`Delete ${sel.length} theme(s)?`)) return;
        overlay.remove();
        await bulkDeleteThemes(sel, themeSelect, skip);
    });

    renderList();
}

/* ============================================================
 * ZIP LIB LOADER (for Smart Import)
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

async function bulkDeleteThemes(names, themeSelect, skipConfirm) {
    let ok = 0, fail = 0;
    for (const name of names) {
        try {
            await deleteThemeByName(themeSelect, name, skipConfirm);
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
                        <p>Theme <b>"${presetName}"</b> already exists in your library.</p>
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
