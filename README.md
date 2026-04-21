# ST-ThemeAssist

A SillyTavern extension for streamlined theme management. Adds a compact, collapsible panel directly under the theme selector in User Settings, with smart import, favorites, a theme manager, and automatic confirmation of the native "@import Custom CSS" dialog.

## Features

### Compact Collapsible Panel
The extension lives inline under the native theme dropdown in **User Settings -> UI Theme**. By default it is collapsed to a single row showing the last applied theme. One click on the header expands it; the collapsed/expanded state is remembered between sessions.

<p align="center">
<img width="620" height="731" alt="image" src="https://github.com/user-attachments/assets/70676db9-7a35-400b-bba6-1e4904090b1c" />
</p>

### Auto-Apply on Import
When you import a new theme through SillyTavern's native import button, ThemeAssist detects the newly added option in the `#themes` selector via a `MutationObserver` and applies it automatically.

### Theme Manager

<p align="center">
<img width="831" height="722" alt="image" src="https://github.com/user-attachments/assets/c643df62-d5d4-435c-84a6-de5ec8341f5f" />
</p>

A popup for managing all installed themes in one place.

- **Search** with live filtering by name
- **Select All** for bulk operations
- **Skip confirmation** toggle for fast bulk deletion without per-item prompts
- **Favorites** via the star icon next to each theme (favorites float to the top)
- **Bulk Delete** for selected themes, routed through the native `#ui-preset-delete-button` with auto-confirmation of the resulting dialog

### Smart Import

<p align="center">
<img width="640" height="310" alt="image" src="https://github.com/user-attachments/assets/4e13fe5f-25c2-435b-b30c-02ac1432104a" />
</p>

One-click import of `.json` theme files.

- If a theme with the same name already exists, a confirmation popup offers **Delete** (replace the old theme with the new one) or **Cancel** (skip the file)
- Import itself is performed through the native `#ui-preset-import-button`, so all SillyTavern validation and storage logic is preserved

### Auto-accept @import CSS Dialog
SillyTavern displays a confirmation popup when a theme's Custom CSS contains `@import` lines. ThemeAssist watches for this popup and automatically clicks **Yes**, eliminating the interruption during bulk imports. The behavior is toggled by the **Auto-accept @import** checkbox in the Theme Manager and is enabled by default.

Detection is handled by a `MutationObserver` on `document.body` combined with a 500 ms polling safety net. The Yes button is located globally by the `.popup-button-ok` selector, with a visibility check through `getBoundingClientRect()` to ignore hidden popups, and a `@import` text check on the parent container to avoid false positives.

### Quick Favorites
Starred themes appear in the **Favorites** section of the panel. Click the theme name to apply it instantly. Click the `x` to remove it from favorites. The star color adapts to the current theme via `--SmartThemeEmColor` with a fallback chain to `--SmartThemeQuoteColor` and the extension's own accent variable.

## Installation

### Via SillyTavern Extension Installer (Recommended)

1. Open SillyTavern
2. Go to **Extensions -> Install Extension**
3. Paste the repository URL:
   ```
   https://github.com/Nufahi/ST-ThemeAssist
   ```
4. Click **Save**
5. Reload SillyTavern with `Ctrl + Shift + R`

### Manual Installation

1. Navigate to your SillyTavern installation folder
2. Open the third-party extensions directory:
   ```
   SillyTavern/public/scripts/extensions/third-party/
   ```
3. Clone or copy the repository there:
   ```bash
   git clone https://github.com/Nufahi/ST-ThemeAssist
   ```
4. Reload SillyTavern with `Ctrl + Shift + R`

## Usage

After installation, open **User Settings**. The ThemeAssist panel appears directly below the theme dropdown in the **UI Theme** section. The panel starts collapsed, showing the last applied theme in the header.

### Applying a Theme
- From **Favorites**, click any theme name to apply it instantly
- From the **Theme Manager**, click a theme name to apply it
- Or use SillyTavern's native dropdown as usual

### Managing Favorites
Open the **Theme Manager** (sliders icon). Click the star next to any theme to toggle its favorite status. Favorites always appear at the top of the list and in the panel's Favorites section.

### Bulk Deletion
In the **Theme Manager**:
1. Check the boxes next to the themes you want to delete (or use **Select All**)
2. Optionally enable **Skip confirmation** to avoid per-item dialogs
3. Click **Delete**

### Smart Import
Click the **Smart Import** icon in the panel. Select one or more `.json` files, or a `.zip` archive containing `.json` theme files.

- New themes are imported directly
- Themes whose name already exists trigger a **Delete / Cancel** dialog; choosing Delete removes the old version and imports the new one
- A final toast reports the total number of imported and skipped themes

### Disabling @import Auto-accept
Open the **Theme Manager** and uncheck **Auto-accept @import**. The native confirmation popup will reappear on subsequent imports.

## Settings

All settings are persisted in `extensionSettings["ST-ThemeAssist"]` and synced through SillyTavern's standard settings system.

| Key | Default | Description |
|-----|---------|-------------|
| `favorites` | `[]` | Array of favorite theme names |
| `collapsed` | `true` | Whether the inline panel is collapsed by default |
| `skipConfirm` | `true` | Skip native confirmation dialogs on bulk delete |
| `autoConfirmImport` | `true` | Auto-click Yes on the @import Custom CSS popup |

## Theme Compatibility

The extension uses native SillyTavern CSS variables so the UI blends with whatever theme is active:

- `--SmartThemeBlurTintColor` - popup background
- `--SmartThemeBorderColor` - borders and dividers
- `--SmartThemeEmColor` - favorite star color (with fallback to `--SmartThemeQuoteColor`)
- `--SmartThemeBodyColor` - primary text
- `--SmartThemeQuoteColor` - secondary accent fallback

No hardcoded colors are used for theme-dependent elements.

## File Structure

```
ST-ThemeAssist/
├── manifest.json    # Extension metadata
├── assist.js        # Main logic (init, managers, import, auto-confirm)
├── assist.css       # Styles using SillyTavern CSS variables
└── assist.html      # Template for the inline panel
```

The HTML template is loaded at runtime via `$.get` and is not referenced directly from `manifest.json`.

## Technical Notes

### Mount Point
The panel is inserted after the `.flex-container` row that wraps `#themes`. If that structure cannot be found, it falls back to appending to `#UI-Theme-Block`, then to `#extensions_settings2`.

### Import Routing
All imports go through SillyTavern's own `#ui-preset-import-button`. A `File` object is injected into the hidden `<input type="file">` via `DataTransfer`, and a `change` event is dispatched. This preserves all native validation, storage, and side effects.

### Duplicate Resolution
When the imported JSON's `presetname` or `name` matches an existing option in the `#themes` dropdown, the extension offers to delete the old theme first. Deletion is performed via the native `#ui-preset-delete-button` with auto-confirmation of the resulting popup via `.popup-button-ok`.

### @import Popup Handler
A `MutationObserver` on `document.body` (subtree + childList + characterData) combined with a 500 ms `setInterval` fallback scans for `.popup-button-ok` elements whose parent popup contains the substring `@import`. A visibility check via `getBoundingClientRect()` prevents clicks on hidden popups. A deduplication flag on the popup container prevents repeated clicks. The click is dispatched three ways (`click()`, `mousedown`, `mouseup`) for compatibility with different event handlers.

## Requirements

- SillyTavern latest release
- No server-side plugins, APIs, or additional dependencies

## License

AGPLv3

## Credits

Author: Nufahi
Bug reports and feature requests: [open an issue](https://github.com/Nufahi/ST-ThemeAssist/issues)
