# VivaldiTweaks

One Windows installer for the two Vivaldi UI mods in this project:

- **Signal constellation:** the local, click-through animated background from
  `weimer.dev`, behind browser framing rather than websites. Includes violet
  stars, links, cursor gravity, explosions, and comet trails. The active tab has
  a brighter violet border and soft drop shadow, including in tab-stack rows.
- **Address bar below tabs:** the built-in auto-hidden address bar reveals below
  persistent top tabs, without reserving an empty row or pushing the page down.
  Density, UI zoom, and a second tab-stack row are accounted for.

These are **unofficial browser UI mods**, not Chrome extensions or an importable
Vivaldi theme. The installer changes the installed browser's `window.html`;
it does not change your browser profile or preferences.

## One-click install (Windows)

1. Download/extract the **whole project** into a permanent folder, or use this
   checkout. Keep it outside Vivaldi's installation directory.
2. **Quit Vivaldi completely**, including background processes.
3. Double-click **[`install.cmd`](install.cmd)**.
4. Check the success message, press Enter to close the installer, and start
   Vivaldi.

No Node.js, npm install, downloads, or build step are needed. Uses Windows'
built-in **Windows PowerShell 5.1**. The launcher permits this script to run only
for its own PowerShell process; it does not change your saved execution policy
or Vivaldi's security settings. Organization-managed script restrictions may
still prevent execution.

The installer finds standard per-user and Program Files installations and
selects the version matching `vivaldi.exe`, not an arbitrary newer or older
resource folder. If multiple installations exist, it asks you to provide a path
rather than modifying the wrong one. It does not force-close or restart Vivaldi.
An all-users installation may require **Run as administrator**.

### Vivaldi settings

The installer loads **both stylesheets directly**, so no CSS experiment or
Custom UI Modifications folder selection is necessary.

- For the **address-bar fix**, put both bars at the **top**, enable UI Auto-Hide,
  check **Address Bar**, and **uncheck Tab Bar** under Settings > Appearance.
  Both-auto-hide, side/bottom tabs, bottom address bars, fullscreen, and floating
  wrappers shared with bookmarks/menus/title bars retain native behavior.
- For **constellation**, choose a **dark theme**. To animate the title-bar area,
  turn off **Use Native Window** under Settings > Appearance > Window Appearance.
  OS-owned title bars cannot be animated. Webpages, Start Page, and expanded
  panels stay opaque.

If you previously installed `address-bar-below-tabs.css` through a Custom UI
Modifications folder, remove **only that CSS file** from that folder to avoid
loading it twice. The installer deliberately does not edit that folder or your
profile settings. Existing installs made with this project's constellation
installer are upgraded in place.

### Nonstandard or multiple installations

Pass an explicit path in a terminal. A Vivaldi installation folder,
`Application` folder, `vivaldi.exe`, version folder, UI resources folder, or
exact `window.html` is accepted:

```bat
install.cmd "D:\Apps\Vivaldi\Application\vivaldi.exe"
uninstall.cmd "D:\Apps\Vivaldi\Application\vivaldi.exe"
```

Advanced use without the closing prompt, including a read-only preview:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -VivaldiPath 'D:\Apps\Vivaldi\Application\vivaldi.exe'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Action Uninstall -VivaldiPath 'D:\Apps\Vivaldi\Application\vivaldi.exe'
```

## Updates, removal, and safety

**After every Vivaldi update:** quit Vivaldi and double-click `install.cmd`
again. JavaScript UI mods do not automatically survive browser updates.

**To remove both mods:** quit Vivaldi and double-click
**[`uninstall.cmd`](uninstall.cmd)**. You can supply an old version's
`window.html` explicitly to remove a mod from retained older resources too.

The installer:

- Creates `window.html.tweaks-backup` once and never overwrites it.
- Copies four local assets into the owned `vivaldi-constellation` folder next
  to `window.html`. This legacy name and its marker comments are retained for
  compatibility with the original constellation installer.
- Loads the simulation engine before its adapter, with one marked loader block.
  Repeated installation updates that block instead of duplicating it.
- Preserves other UI mods, HTML encoding/BOM, and line endings.
- Checks inputs and ownership before writing; rejects malformed markers,
  symlinks/junctions on managed paths, and unowned destination folders.
- Uses atomic file replacement, an exclusive temporary installer lock, and
  asset rollback if installation fails before committing the loader.
- Uninstalls only its own marked block and known assets. Unknown files and
  backups stay in place. It never restores a possibly stale whole-file backup
  over a newer or separately modified browser UI.

Keep the backup for recovery, not as an automatic uninstall mechanism. If
Vivaldi will not open, `uninstall.cmd` works without launching the browser.
If an error reports a failed rollback, repair the named installation before
reopening Vivaldi.

## Compatibility and validation

The one-click installer is **Windows-only**. The original address-bar mod was
tested on Vivaldi **8.2.4133.87** on Windows. The constellation animation uses a
30 fps cap, a two-million-pixel canvas budget, reduced-motion support, and
focus/minimize pausing. UI selectors are not a stable Vivaldi API; test after
browser upgrades and when combining layout mods.

The installer tests exercise **temporary fixture installations**, not your
installed browser. They cover both Windows launchers, install/reinstall/remove,
upgrading a legacy constellation install, preservation of unrelated files,
backups/encoding, read-only preview, and failure paths. Simulation tests preserve
the constellation thread's dependency-free coverage.

For development tests, **Node.js 22+** is required, but no npm dependencies:

```sh
npm test
```

Windows installer tests are skipped on other operating systems. File-symlink
checks also skip when Windows denies symlink creation (Developer Mode or
elevation is required); junction checks still run.

A real-browser acceptance check is still needed for the combination: restart
Vivaldi, check that the animation appears behind usable controls, hover from
the top edge through the tabs into the address bar, try `Ctrl+L`/Escape, drag
a tab/window, resize, minimize/restore, and uninstall/restart. Browser automation
alone does not establish OS-level hover and drag behavior.

## Source

The runtime files combine this project's constellation and address-bar threads:

- `constellation/constellation-engine.js`: the `weimer.dev` simulation port.
- `constellation/constellation.js`: Vivaldi lifecycle, rendering, and pointer input.
- `constellation/constellation.css`: transparent frame surfaces and active-tab styling.
- `mods/address-bar-below-tabs.css`: CSS anchor-sized native auto-hide wrapper.

Original constellation by Max Weimer (`weimer.dev`). MIT — see [LICENSE](LICENSE).
