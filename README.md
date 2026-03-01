# ST-ThemeAssist ༊༄.°
🎨 SillyTavern extension for bulk theme management – backup, restore, export as ZIP, favorites, and auto-apply on import.

## Features

### Auto-Apply on Import
When you import a new theme (via SillyTavern's native import), ThemeAssist automatically detects and applies it — no need to manually select it from the dropdown.

### Theme Manager
A full-featured popup for managing all your themes in one place:
- **Search** — quickly filter themes by name
- **Bulk Select** — select multiple themes at once with "Select All"
- **Bulk Export** — export selected themes as a single `.zip` file (no per-file save dialogs)
- **Bulk Delete** — delete multiple themes at once, with optional skip-confirmation mode
- **Favorites** — star your favorite themes so they always appear at the top

### Backup & Restore
- **Backup All** — exports every installed theme into a single `.zip` archive with one click
- **Restore** — import themes from `.zip` or individual `.json` files, bulk importing them back into SillyTavern

### Quick Favorites
Pin your most-used themes for one-click switching directly from the settings panel. No more scrolling through dozens of themes.

## Installation

### Via SillyTavern Extension Installer (Recommended)
1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Paste the repository URL:
   ```
   https://github.com/Nufahi/ST-ThemeAssist
   ```
4. Click **Save**
5. Reload SillyTavern (`Ctrl + Shift + R`)

### Manual Installation
1. Navigate to your SillyTavern installation folder
2. Go to:
   ```
   data/<your-user>/extensions/
   ```
3. Clone or copy the `ST-ThemeAssist` folder there:
   ```bash
   git clone https://github.com/Nufahi/ST-ThemeAssist
   ```
4. Reload SillyTavern (`Ctrl + Shift + R`)

## Usage

After installation, find **Theme Assist** in the Extensions settings panel (bottom of the sidebar).

### Backing Up Themes
Click **Backup All** to export every theme as a single `.zip` file. The file downloads automatically — no confirmation dialogs for each theme.

### Restoring Themes
Click **Restore** and select either:
- A `.zip` archive (exported by ThemeAssist or containing `.json` theme files)
- One or more individual `.json` theme files

All selected themes will be imported automatically.

### Managing Themes
Click **Theme Manager** to open the management popup where you can:
1. Search for themes using the search bar
2. Star themes to add them to Quick Favorites
3. Select multiple themes and export them as `.zip`
4. Select multiple themes and delete them in bulk

### Quick Favorites
Starred themes appear in the **Quick Favorites** section of the settings panel. Click any favorite to instantly switch to that theme.

## File Structure

```
ST-ThemeAssist/
├── manifest.json    # Extension metadata
├── index.js         # Main extension logic
├── settings.html    # Settings panel UI
├── style.css        # Custom styles
└── README.md
```

## Requirements

- SillyTavern (latest release version recommended)
- No additional server plugins or APIs required

## License

AGPLv3
[README.md](https://github.com/user-attachments/files/25661181/README.md)
vern extension for bulk theme management – backup, restore, export as ZIP, favorites, and auto-apply on import.
