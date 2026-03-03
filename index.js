const MODULE_NAME = 'ST-ThemeAssist';
const DISPLAY_NAME = 'ThemeAssist';
const extPath = `scripts/extensions/third-party/${MODULE_NAME}`;

let JSZipLib = null;

async function loadJSZip() {
    if (JSZipLib) return JSZipLib;
    if (window.JSZip) {
        JSZipLib = window.JSZip;
        return JSZipLib;
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
        script.onload = () => {
            JSZipLib = window.JSZip;
            console.log(`[${MODULE_NAME}] JSZip loaded`);
            resolve(JSZipLib);
        };
        script.onerror = () => {
            toastr.error('Failed to load JSZip library', DISPLAY_NAME);
            reject(new Error('JSZip load failed'));
        };
        document.head.appendChild(script);
    });
}

jQuery(async () => {
    console.log(`[${MODULE_NAME}] Loading...`);

    try {
        const settingsHtml = await $.get(`${extPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);

        const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = { favorites: [] };
        }
        if (!extensionSettings[MODULE_NAME].favorites) {
            extensionSettings[MODULE_NAME].favorites = [];
        }

        const themeSelect = document.getElementById('themes');
        if (!themeSelect) {
            console.error(`[${MODULE_NAME}] Theme selector #themes not found!`);
            return;
        }

        let knownThemes = new Set(
            Array.from(themeSelect.options).map(opt => opt.value)
        );
        console.log(`[${MODULE_NAME}] Tracking ${knownThemes.size} existing themes`);

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.removedNodes) {
                    if (node.tagName === 'OPTION' && knownThemes.has(node.value)) {
                        knownThemes.delete(node.value);
                        console.log(`[${MODULE_NAME}] Theme removed from tracking: "${node.value}"`);
                    }
                }

                for (const node of mutation.addedNodes) {
                    if (node.tagName === 'OPTION' && !knownThemes.has(node.value)) {
                        const newThemeName = node.value;
                        console.log(`[${MODULE_NAME}] New theme detected: "${newThemeName}"`);
                        themeSelect.value = newThemeName;
                        $(themeSelect).trigger('change');
                        knownThemes.add(newThemeName);
                        toastr.success(`Applied: "${newThemeName}"`, DISPLAY_NAME);
                        $('#ta_last_applied').text(newThemeName);
                    }
                }
            }
        });
        observer.observe(themeSelect, { childList: true });

        $('#ta_theme_manager_btn').on('click', () => openThemeManager(themeSelect));
        $('#ta_backup_btn').on('click', () => backupAllThemes(themeSelect));
        $('#ta_restore_btn').on('click', () => restoreThemes(themeSelect));
        renderFavoritesPanel(themeSelect);

        console.log(`[${MODULE_NAME}] Loaded successfully`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to load:`, error);
    }
});

function getFavorites() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[MODULE_NAME]?.favorites || [];
}

function toggleFavorite(themeName) {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const favs = extensionSettings[MODULE_NAME].favorites;
    const idx = favs.indexOf(themeName);
    if (idx === -1) {
        favs.push(themeName);
    } else {
        favs.splice(idx, 1);
    }
    saveSettingsDebounced();
    return idx === -1;
}

function renderFavoritesPanel(themeSelect) {
    const favs = getFavorites();
    const container = $('#ta_favorites_list');
    container.empty();

    if (favs.length === 0) {
        container.html('<small style="opacity:0.5">No favorites yet \u2014 add via Theme Manager</small>');
        return;
    }

    for (const fav of favs) {
        const item = $(`<div class="ta-fav-item">
            <span class="ta-fav-name" title="Click to apply">${fav}</span>
            <span class="ta-fav-remove fa-solid fa-xmark" title="Remove from favorites"></span>
        </div>`);

        item.find('.ta-fav-name').on('click', () => {
            themeSelect.value = fav;
            $(themeSelect).trigger('change');
            toastr.info(`Applied: "${fav}"`, DISPLAY_NAME);
        });

        item.find('.ta-fav-remove').on('click', () => {
            toggleFavorite(fav);
            renderFavoritesPanel(themeSelect);
            toastr.info(`Removed from favorites`, DISPLAY_NAME);
        });

        container.append(item);
    }
}

async function getThemeData(themeName, themeSelect) {
    themeSelect.value = themeName;
    $(themeSelect).trigger('change');
    await new Promise(r => setTimeout(r, 300));

    const exportBtn = document.getElementById('ui_preset_export_button');
    if (!exportBtn) throw new Error('Export button not found');

    return new Promise((resolve, reject) => {
        const origCreate = URL.createObjectURL;
        const origClick = HTMLAnchorElement.prototype.click;

        URL.createObjectURL = function (blob) {
            URL.createObjectURL = origCreate;
            HTMLAnchorElement.prototype.click = origClick;
            blob.text().then(text => resolve(text)).catch(reject);
            return 'blob:blocked';
        };

        HTMLAnchorElement.prototype.click = function () {
            if (this.download) return;
            return origClick.call(this);
        };

        exportBtn.click();

        setTimeout(() => {
            URL.createObjectURL = origCreate;
            HTMLAnchorElement.prototype.click = origClick;
            reject(new Error('Export timeout'));
        }, 3000);
    });
}

async function bulkExportThemes(themeNames, themeSelect) {
    const zip = await loadJSZip();
    if (!zip) return;

    const originalTheme = themeSelect.value;
    let exported = 0;

    toastr.info(`Exporting ${themeNames.length} themes...`, DISPLAY_NAME);

    const zipFile = new JSZipLib();

    for (const name of themeNames) {
        try {
            const data = await getThemeData(name, themeSelect);
            const safeName = name.replace(/[<>:"/\\|?*]/g, '_');
            zipFile.file(`${safeName}.json`, data);
            exported++;
            console.log(`[${MODULE_NAME}] Exported: "${name}" (${exported}/${themeNames.length})`);
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to export "${name}":`, err);
        }
    }

    themeSelect.value = originalTheme;
    $(themeSelect).trigger('change');

    if (exported === 0) {
        toastr.error('No themes exported', DISPLAY_NAME);
        return;
    }

    const blob = await zipFile.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `themes-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${exported} themes as ZIP`, DISPLAY_NAME);
}

async function backupAllThemes(themeSelect) {
    const themes = Array.from(themeSelect.options).map(opt => opt.value);
    if (!confirm(`Backup all ${themes.length} themes as ZIP?`)) return;
    await bulkExportThemes(themes, themeSelect);
}

async function restoreThemes(themeSelect) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.json';
    input.multiple = true;

    input.addEventListener('change', async () => {
        const files = Array.from(input.files);
        if (files.length === 0) return;

        let jsonFiles = [];

        for (const file of files) {
            if (file.name.endsWith('.zip')) {
                const zip = await loadJSZip();
                if (!zip) return;

                const zipData = await JSZipLib.loadAsync(file);
                const zipJsonFiles = Object.keys(zipData.files).filter(f => f.endsWith('.json'));

                toastr.info(`Found ${zipJsonFiles.length} themes in ZIP...`, DISPLAY_NAME);

                for (const jsonName of zipJsonFiles) {
                    try {
                        const content = await zipData.files[jsonName].async('blob');
                        const jsonFile = new File([content], jsonName, { type: 'application/json' });
                        jsonFiles.push(jsonFile);
                    } catch (err) {
                        console.error(`[${MODULE_NAME}] Failed to extract "${jsonName}":`, err);
                    }
                }
            } else if (file.name.endsWith('.json')) {
                jsonFiles.push(file);
            }
        }

        if (jsonFiles.length === 0) {
            toastr.error('No theme files found', DISPLAY_NAME);
            return;
        }

        toastr.info(`Importing ${jsonFiles.length} themes...`, DISPLAY_NAME);

        let imported = 0;
        let failed = 0;

        for (const jsonFile of jsonFiles) {
            try {
                const result = await importThemeWithReplacePrompt(jsonFile, themeSelect);
                imported++;
                console.log(`[${MODULE_NAME}] Imported: "${jsonFile.name}" (${imported}/${jsonFiles.length})`);
                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                failed++;
                console.error(`[${MODULE_NAME}] Failed to import "${jsonFile.name}":`, err);
            }
        }

        toastr.success(`Imported ${imported} theme(s)${failed ? `, ${failed} failed` : ''}`, DISPLAY_NAME);
    });

    input.click();
}

function importViaNativeButton(file) {
    return new Promise((resolve, reject) => {
        const importBtn = document.getElementById('ui_preset_import_button');
        if (!importBtn) {
            reject(new Error('Import button not found'));
            return;
        }

        let fileInput = importBtn.querySelector('input[type="file"]');
        if (!fileInput) {
            fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json';
            fileInput.style.display = 'none';
            importBtn.appendChild(fileInput);
        }

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;

        const changeEvent = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(changeEvent);

        setTimeout(() => resolve(), 800);
    });
}



async function importThemeWithReplacePrompt(jsonFile, themeSelect) {
    let presetName = null;
    let freshFile = jsonFile;

    try {
        const text = await jsonFile.text();
        const data = JSON.parse(text);
        presetName = data.preset_name || data.name || null;
        freshFile = new File([text], jsonFile.name, { type: jsonFile.type || 'application/json' });
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to read theme file "${jsonFile.name}":`, err);
        await importViaNativeButton(jsonFile);
        return;
    }

    if (!presetName) {
        console.warn(`[${MODULE_NAME}] No preset_name in "${jsonFile.name}", importing as usual`);
        await importViaNativeButton(freshFile);
        return;
    }

    const existingOption = Array.from(themeSelect.options).find(opt => opt.value === presetName);

    if (!existingOption) {
        await importViaNativeButton(freshFile);
        toastr.success(`Imported new theme: "${presetName}"`, DISPLAY_NAME);
        return;
    }

    return new Promise(async (resolve, reject) => {
        const overlay = document.createElement('div');
        overlay.id = 'ta_popup_overlay';
        overlay.innerHTML = `
            <div class="ta-popup">
                <div class="ta-popup-header">
                    <h3>Theme already exists</h3>
                    <span id="ta_replace_close" class="fa-solid fa-xmark ta-close-btn"></span>
                </div>
                <div class="ta-popup-body">
                    <p>Theme "<b>${presetName}</b>" already exists.</p>
                    <p>Delete the old one first, then import the new JSON.</p>
                </div>
                <div class="ta-popup-footer">
                    <div class="ta-footer-buttons">
                        <div id="ta_replace_cancel" class="menu_button menu_button_icon interactable" style="background:#555;">
                            <i class="fa-solid fa-ban"></i> Cancel
                        </div>
                        <div id="ta_replace_confirm" class="menu_button menu_button_icon interactable" style="background:#8b2035;">
                            <i class="fa-solid fa-trash-can"></i> Delete old
                        </div>
                    </div>
                </div>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                toastr.info('Cancelled', DISPLAY_NAME);
                resolve(false);
            }
        });

        document.body.appendChild(overlay);

        const close = overlay.querySelector('#ta_replace_close');
        const cancel = overlay.querySelector('#ta_replace_cancel');
        const confirmBtn = overlay.querySelector('#ta_replace_confirm');

        const cleanup = () => {
            overlay.remove();
        };

        cancel.addEventListener('click', () => {
            cleanup();
            toastr.info('Cancelled', DISPLAY_NAME);
            resolve(false);
        });

        close.addEventListener('click', () => {
            cleanup();
            toastr.info('Cancelled', DISPLAY_NAME);
            resolve(false);
        });

        confirmBtn.addEventListener('click', async () => {
            try {
                themeSelect.value = presetName;
                $(themeSelect).trigger('change');
                await new Promise(r => setTimeout(r, 400));

                const deleteBtn = document.getElementById('ui-preset-delete-button');
                if (!deleteBtn) throw new Error('Delete button not found');

                deleteBtn.click();

                const ok = await waitForPopupAndConfirm();
                if (!ok) {
                    throw new Error('Delete confirmation failed');
                }

                await new Promise(r => setTimeout(r, 400));

                overlay.querySelector('.ta-popup').innerHTML = `
                    <div class="ta-popup-header">
                        <h3>Now import the new theme</h3>
                        <span id="ta_replace_close2" class="fa-solid fa-xmark ta-close-btn"></span>
                    </div>
                    <div class="ta-popup-body">
                        <p>Old "<b>${presetName}</b>" deleted successfully!</p>
                        <p>Click the button below to import your new JSON.</p>
                    </div>
                    <div class="ta-popup-footer">
                        <div class="ta-footer-buttons">
                            <div id="ta_import_now" class="menu_button menu_button_icon interactable" style="background:#28a745;">
                                <i class="fa-solid fa-file-import"></i> Import new theme
                            </div>
                        </div>
                    </div>
                `;

                overlay.querySelector('#ta_replace_close2').addEventListener('click', () => {
                    cleanup();
                    resolve(true);
                });

                overlay.querySelector('#ta_import_now').addEventListener('click', () => {
                    cleanup();

                    const importBtn = document.getElementById('ui_preset_import_button');
                    if (!importBtn) {
                        toastr.error('Import button not found', DISPLAY_NAME);
                        resolve(true);
                        return;
                    }

                    const fileInput = importBtn.querySelector('input[type="file"]');
                    if (!fileInput) {
                        toastr.error('File input inside import button not found', DISPLAY_NAME);
                        resolve(true);
                        return;
                    }

                    fileInput.onclick = null;
                    fileInput.click();
                    resolve(true);
                });

            } catch (err) {
                console.error(`[${MODULE_NAME}] Failed to delete "${presetName}":`, err);
                toastr.error(`Failed to delete "${presetName}"`, DISPLAY_NAME);
                cleanup();
                reject(err);
            }
        });
    });
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

function openThemeManager(themeSelect) {
    const currentTheme = themeSelect.value;
    const themes = Array.from(themeSelect.options).map(opt => opt.value);
    const favs = getFavorites();

    let html = `<div class="ta-bulk">
        <div class="ta-bulk-controls">
            <input type="text" id="ta_search" placeholder="\uD83D\uDD0E\uFE0E Search themes..." class="text_pole" style="width:100%;">
        </div>
        <div class="ta-bulk-controls">
            <label><input type="checkbox" id="ta_select_all"> \u2714 Select All</label>
            <label><input type="checkbox" id="ta_skip_confirm"> \u23ED Skip confirmation</label>
        </div>
        <div class="ta-bulk-controls-info">
            <small>${themes.length} themes \u00B7 ${favs.length} favorites</small>
        </div><hr><div class="ta-theme-list">`;

    const sorted = [...themes].sort((a, b) => {
        const aFav = favs.includes(a) ? 0 : 1;
        const bFav = favs.includes(b) ? 0 : 1;
        return aFav - bFav;
    });

    for (const theme of sorted) {
        const isCurrent = theme === currentTheme;
        const isFav = favs.includes(theme);

        html += `<div class="ta-theme-item ${isCurrent ? 'ta-theme-current' : ''} ${isFav ? 'ta-theme-fav' : ''}" data-theme="${theme.replace(/"/g, '&quot;')}">
            <input type="checkbox" value="${theme.replace(/"/g, '&quot;')}" ${(isCurrent || isFav) ? 'disabled' : ''}>
            <span class="ta-star ${isFav ? 'ta-star-active' : ''}" title="Toggle favorite">\u2605</span>
            <span class="ta-theme-name">${theme}${isCurrent ? ' \u25C6' : ''}</span>
        </div>`;
    }

    html += `</div></div>`;

    const popup = document.createElement('div');
    popup.id = 'ta_popup_overlay';
    popup.innerHTML = `
        <div class="ta-popup">
            <div class="ta-popup-header">
                <h3>Theme Manager</h3>
                <span id="ta_popup_close" class="fa-solid fa-xmark ta-close-btn"></span>
            </div>
            <div class="ta-popup-body">${html}</div>
            <div class="ta-popup-footer">
                <span id="ta_selected_count">0 selected</span>
                <div class="ta-footer-buttons">
                    <div id="ta_export_selected" class="menu_button menu_button_icon interactable">
                        <i class="fa-solid fa-file-export"></i> Export
                    </div>
                    <div id="ta_confirm_delete" class="menu_button menu_button_icon interactable" style="background:#8b2035;">
                        <i class="fa-solid fa-trash-can"></i> Delete
                    </div>
                </div>
            </div>
        </div>`;

    document.body.appendChild(popup);

    popup.querySelector('#ta_search').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        popup.querySelectorAll('.ta-theme-item').forEach(item => {
            item.style.display = item.dataset.theme.toLowerCase().includes(query) ? '' : 'none';
        });
    });

    function updateCount() {
        const count = popup.querySelectorAll('.ta-theme-list input:checked').length;
        popup.querySelector('#ta_selected_count').textContent = `${count} selected`;
    }

    popup.querySelectorAll('.ta-star').forEach(star => {
        star.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = star.closest('.ta-theme-item');
            const themeName = item.dataset.theme;
            const added = toggleFavorite(themeName);
            star.classList.toggle('ta-star-active', added);
            item.classList.toggle('ta-theme-fav', added);

            const cb = item.querySelector('input[type="checkbox"]');
            const isCurrent = themeName === themeSelect.value;
            if (!isCurrent) {
                cb.disabled = added;
                if (added) cb.checked = false;
            }

            toastr.info(`${added ? 'Added to' : 'Removed from'} favorites`, DISPLAY_NAME);
            renderFavoritesPanel(themeSelect);
            updateCount();
        });
    });

    popup.querySelector('#ta_select_all').addEventListener('change', (e) => {
        popup.querySelectorAll('.ta-theme-list input[type="checkbox"]:not(:disabled)').forEach(cb => {
            if (cb.closest('.ta-theme-item').style.display !== 'none') cb.checked = e.target.checked;
        });
        updateCount();
    });

    popup.querySelector('.ta-theme-list').addEventListener('change', updateCount);

    popup.querySelector('#ta_popup_close').addEventListener('click', () => popup.remove());
    popup.addEventListener('click', (e) => { if (e.target === popup) popup.remove(); });

    popup.querySelector('#ta_export_selected').addEventListener('click', async () => {
        const toExport = Array.from(popup.querySelectorAll('.ta-theme-list input:checked')).map(cb => cb.value);
        if (toExport.length === 0) {
            toastr.warning('Select at least one theme', DISPLAY_NAME);
            return;
        }
        popup.remove();
        await bulkExportThemes(toExport, themeSelect);
    });

    popup.querySelector('#ta_confirm_delete').addEventListener('click', async () => {
        const toDelete = Array.from(popup.querySelectorAll('.ta-theme-list input:checked')).map(cb => cb.value);
        const skipConfirm = popup.querySelector('#ta_skip_confirm').checked;

        if (toDelete.length === 0) {
            toastr.warning('Select at least one theme', DISPLAY_NAME);
            return;
        }

        if (!skipConfirm) {
            if (!confirm(`Delete ${toDelete.length} theme(s)? You'll confirm each one.`)) return;
        } else {
            if (!confirm(`Delete ${toDelete.length} theme(s) without confirmation? This cannot be undone.`)) return;
        }

        popup.style.display = 'none';
        let deleted = 0, failed = 0;

        for (const themeName of toDelete) {
            try {
                themeSelect.value = themeName;
                $(themeSelect).trigger('change');
                await new Promise(r => setTimeout(r, 400));

                document.getElementById('ui-preset-delete-button').click();

                if (skipConfirm) {
                    await waitForPopupAndConfirm();
                } else {
                    await new Promise(resolve => {
                        const check = setInterval(() => {
                            if (!document.querySelector('.popup-button-ok')) {
                                clearInterval(check);
                                resolve();
                            }
                        }, 200);
                    });
                }

                deleted++;
                console.log(`[${MODULE_NAME}] Deleted: "${themeName}" (${deleted}/${toDelete.length})`);
            } catch (err) {
                failed++;
                console.error(`[${MODULE_NAME}] Failed to delete "${themeName}":`, err);
            }
        }

        popup.remove();
        toastr.success(`Deleted ${deleted} theme(s)${failed ? `, ${failed} failed` : ''}`, DISPLAY_NAME);
    });
}
