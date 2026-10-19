# Faros Toolbox

One place to install, update and start the Faros desktop apps, like JetBrains Toolbox does for the JetBrains IDEs:

| App | What it does | Releases |
|---|---|---|
| **Shellfish** | SSH terminal and dual-pane SFTP client | [FarosBelgium/shellfish](https://github.com/FarosBelgium/shellfish/releases) |
| **EDB\*Max** | Run SQL files on EDB Postgres with EDB\*Plus | [FarosBelgium/edbmax](https://github.com/FarosBelgium/edbmax/releases) |
| **VPNMaster** | Saved Cisco Secure Client VPNs, one click to connect | [FarosBelgium/VpnMaster](https://github.com/FarosBelgium/VpnMaster/releases) |

The window lists the apps under **Installed** (with the version you have, and the new version if there is one) and **Available**. Per app:

- **Install** / **Update** / **Open**, and under **⋯**: release notes and **Uninstall…**
- **Update all** in the banner when several apps have an update. On Linux that asks for your password once for all of them.
- A progress bar while downloading; a message under the app if something goes wrong.

If an app is running when you update it, the toolbox asks to close it, installs the update and starts it again.

The toolbox keeps running in the system tray when you close the window (switch that off in **⚙ Settings**). The tray menu starts the installed apps, and shows how many updates there are. It checks for updates at startup and every 4 hours, and shows a notification once per new version.

**⚙ Settings**: check automatically, install updates automatically (only apps that aren't running), notifications, keep running in the tray, start at login.

## How it works

Each app publishes its installers as a GitHub Release, built by electron-builder, with an update feed per OS (`latest-linux.yml`, `latest.yml`, `latest-mac.yml`). The toolbox reads those feeds from `https://github.com/<owner>/<repo>/releases/latest/download/…`. Those are plain downloads, not the GitHub API, so there is no API rate limit, also not when the whole office shares one IP address.

Every installer is checked against the SHA-512 checksum in the feed. A download only gets its final name once the checksum matches; a corrupt or tampered file is deleted and never run.

| System | Installs | Installed version from | Uninstall |
|---|---|---|---|
| Ubuntu / Debian | the `.deb` with `pkexec apt-get install` (password prompt; apt also installs missing dependencies) | `dpkg-query` | `apt-get remove` (keeps your settings) |
| Windows | `<App>-Setup-<version>.exe /S`: silent, per user, no admin rights | the uninstall entry in the registry | the app's own uninstaller, silently |
| macOS | the `.zip` for your CPU (Apple Silicon / Intel), unpacked into `/Applications` (or `~/Applications`) | `Info.plist` of the `.app` | moves the `.app` to the Trash |

On macOS the apps can't update themselves (they aren't signed with an Apple Developer certificate), but the toolbox can: it replaces the `.app` bundle. Files it downloads don't get the quarantine flag, so macOS doesn't block the first start either.

The apps' own built-in updaters keep working next to the toolbox: both use the same releases.

### Adding an app

Add it to [src/main/catalog.js](src/main/catalog.js) and put a 128×128 icon in `src/renderer/assets/apps/`. The app must be published like the others: electron-builder with the `github` publish provider, a Linux `.deb`, a Windows NSIS installer (per user) and macOS `.zip` files.

## Install

Download the installer from the [latest release](https://github.com/FarosBelgium/faros-toolbox/releases/latest):

| System | File |
|---|---|
| Ubuntu / Debian | `faros-toolbox_<version>_amd64.deb`, then `sudo apt install ./faros-toolbox_<version>_amd64.deb` |
| Windows 10/11 | `FarosToolbox-Setup-<version>.exe` (not code-signed: SmartScreen → **More info** → **Run anyway**) |
| macOS | `FarosToolbox-<version>-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel); first start: **System Settings → Privacy & Security → Open Anyway** |

The toolbox updates itself from this repository's releases, the same way the apps do (on macOS it shows a download button).

### Publishing a new version

1. Raise `version` in `package.json` and commit.
2. Tag and push: `git tag v1.0.1 && git push origin main v1.0.1`
3. GitHub Actions tests and builds on Linux, Windows and macOS, and on Linux also installs and uninstalls a real app (VPNMaster) through pkexec. Only if everything passes does it publish the GitHub Release.

## Run from source

```bash
npm install
npm start
```

On Ubuntu 23.10+ run `npm run setup:linux` once first (AppArmor profile for Electron's sandbox, asks for sudo).

### Tests

```bash
npm test                # or on Linux: npm run test:headless (no windows pop up)
```

The end-to-end tests serve update feeds from a local HTTP server and install into a temporary folder instead of the real system, then drive the real UI: install, update, **Update all** in one go, a tampered download being rejected, a cancelled password prompt, a running app being closed and restarted, automatic updates, uninstall, and settings.

`npx electron test/linux-install-test.js vpnmaster` installs and uninstalls a real app on Linux (asks for your password; the app must not be installed yet). CI runs it.

### Building the installers

```bash
npm run dist        # Linux .deb
npm run dist:win    # Windows installer (on Linux this needs Wine)
npm run dist:mac    # macOS .dmg + .zip (only on a Mac)
```

Icons are generated from `src/renderer/assets/icon.svg` (and `tray-mac.svg` for the macOS menu bar) with `npm run icons`.

## Where things are stored

| | Linux | Windows | macOS |
|---|---|---|---|
| Settings | `~/.config/faros-toolbox/settings.json` | `%APPDATA%\faros-toolbox\settings.json` | `~/Library/Application Support/faros-toolbox/settings.json` |
| Log | `…/faros-toolbox/logs/` (also via **⚙ → Open log folder**) | | |

Downloads go to `…/faros-toolbox/downloads/` and are deleted after a successful install.

Set `FAROS_TOOLBOX_HOME=/some/path` to keep these somewhere else.
