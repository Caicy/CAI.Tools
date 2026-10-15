# CAI.Tools

<div align="center">

<img src="./.github/assets/icon.png" alt="CAI.Tools Logo" width="120">

**A Local, Login-Free Application Launcher and Plugin Platform**

_Local-edition fork of [ZTools](https://github.com/ZToolsCenter/ZTools) | Current version 3.2.0-local.3_

[![GitHub release](https://img.shields.io/github/v/release/Caicy/CAI.Tools)](https://github.com/Caicy/CAI.Tools/releases)
[![License](https://img.shields.io/github/license/Caicy/CAI.Tools)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/Caicy/CAI.Tools)

English | [简体中文](./README_CN.md)

</div>

## ✨ Features

- 🚀 **Quick Launch** - Pinyin search, regex matching, history tracking, pinned apps
- 🧩 **Plugin System** - Support for UI plugins and headless plugins with complete API support
- 📋 **Clipboard Management** - History tracking, search, image support, cross-platform native implementation
- 🖱️ **Super Panel** - Triggered by middle click or long-pressed right click, recognizes clipboard content
- 🎈 **Floating Ball** - Always-on-top ball with single/double click actions
- 🌐 **Offline Translation** - Bergamot WASM + Firefox translation models, no network required
- 🤖 **AI Integration** - Self-configured OpenAI-compatible providers with streaming plugin chat
- 🔌 **MCP Server** - Exposes plugin tools over JSON-RPC, disabled by default, port 36579
- 🛰️ **HTTP API** - Lets external programs call app features and launch plugins, disabled by default, port 36578
- 🌍 **Browser Automation** - ZBrowser window pool with an isolated session per plugin
- 🪟 **Detached Windows** - Turn any plugin into a standalone window with custom size
- 🔎 **Web Quick-Open** - Configurable search engines and search redirects
- 🎨 **Theme Customization** - System/light/dark mode with 5 preset colors plus a custom color picker
- ⚡ **High Performance** - LMDB database, WebContentsView architecture, ultra-fast response
- 🔒 **Data Isolation** - Per-plugin namespaces keep plugin data separate and safe
- 🛠️ **Developer Friendly** - Full TypeScript types, hot reload, Vitest and Playwright E2E

## 📸 Preview

<div align="center">
  <img src="./.github/assets/demo.gif" alt="CAI.Tools Demo" width="600">
  <p><i>Quick launch and search functionality demo</i></p>
</div>

### Interface Showcase

<div align="center">
  <table>
    <tr>
      <td width="50%">
        <img src="./.github/assets/main-light.png" alt="Main Interface - Light Theme">
        <p align="center"><i>Main Interface - Light Theme</i></p>
      </td>
      <td width="50%">
        <img src="./.github/assets/main-dark.png" alt="Main Interface - Dark Theme">
        <p align="center"><i>Main Interface - Dark Theme</i></p>
      </td>
    </tr>
    <tr>
      <td width="50%">
        <img src="./.github/assets/settings.png" alt="Settings">
        <p align="center"><i>Settings - Theme Customization and General Settings</i></p>
      </td>
      <td width="50%">
        <img src="./.github/assets/plugin-market.png" alt="Plugin Market">
        <p align="center"><i>Plugin Market - Anonymous Browsing and Installation</i></p>
      </td>
    </tr>
  </table>
</div>

## 🔒 Local Edition Boundaries

CAI.Tools is a login-free local edition. The startup chain does not load the official account, payment, or cloud-sync modules; the compatibility entries for those capabilities return `OFFICIAL_CAPABILITY_UNAVAILABLE` explicitly instead of failing silently.

| Capability           | Local edition status                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Official account     | Not provided; `getUser` returns `null`                                                                                   |
| Payment              | Not provided; calls return an explicit failure                                                                           |
| Official cloud sync  | Not provided; activity heartbeat and sync modules removed from the startup chain                                         |
| Plugin market        | Anonymous access, requests carry no `Authorization`; account-dependent actions fail before any network call              |
| AI                   | Self-configured providers only; official AI queries return an explicit failure                                           |
| Updates              | Manual check against the upstream GitHub Release; auto-check always off, no download or install                          |
| Plugin compatibility | Plugin APIs report the upstream baseline `3.2.0`, while the app and settings show the full local version `3.2.0-local.3` |

### Data Directory

The default data root is `~/.cai-tools` and can be overridden with the `ZTOOLS_DATA_ROOT` environment variable. The app never probes or imports upstream `.ztools` user data.

- Device store: `<root>/lmdb/device`
- Default account store: `<root>/lmdb/accounts/default`
- Namespaces: `ZTOOLS/` (main app), `PLUGIN/{name}/` (automatic per-plugin isolation)

### Git Mirror

The Git mirror protocol, plugin data projection, and AI credential isolation are implemented: plugin data is exported through explicit projection adapters, and AI credentials always stay on the local device. **Automatic sync and multi-machine migration are not complete** — protocol support does not imply a finished sync flow.

## 🧰 Bundled Plugins

Bundled plugins live in `internal-plugins/` and ship inside the app. Being bundled does not grant internal API privileges; the allow list is defined in `src/main/core/internalPlugins.ts`.

| Plugin         | Description                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setting`      | App settings UI, a standalone Vue project (Vite + UnoCSS)                                                                                                                                                             |
| `system`       | System tools                                                                                                                                                                                                          |
| `string-tools` | Offline text workbench: SQL IN list building, case and naming conversion, bidirectional Unicode escaping, line deduplication. Never stores input history. See its [README](./internal-plugins/string-tools/README.md) |

## 🚀 Quick Start

### Installation

#### Method 1: Download Pre-built Version (Recommended)

Download the Windows x64 local edition from [Releases](https://github.com/Caicy/CAI.Tools/releases):

- `CAI.Tools-x.x.x-win-x64-setup.exe` - NSIS installer
- `CAI.Tools-x.x.x-win-x64.zip` - Portable archive
- `SHA256SUMS.txt` - Checksums

No pre-built macOS or Linux artifacts yet; build from source instead.

#### Method 2: Build from Source

```bash
# Clone the repository with submodules
git clone https://github.com/Caicy/CAI.Tools.git --recurse-submodules
cd CAI.Tools

# Install dependencies
pnpm install

# Development mode
pnpm dev

# Build
pnpm build:win       # Windows
pnpm build:mac       # macOS (host arch)
pnpm build:linux     # Linux (host arch)
```

### Usage

1. After launching the app, press `Alt+Z` (Windows) or `Option+Z` (macOS) to open the main interface; the shortcut is configurable in settings
2. Enter an application name or command to search, with pinyin support
3. Use `↑` `↓` `←` `→` to navigate, `Enter` to confirm, `Esc` to exit

## 🧩 Plugin Development

CAI.Tools keeps the ZTools plugin model: simple configuration, rich APIs, and cross-platform support.

**Plugin System Features**:

- 📝 **Simple Configuration** - Define plugins through standard `plugin.json` files, no complex setup required
- 🔌 **Rich APIs** - Access system capabilities through the global `ztools` object, including notifications, simulated input, persistent storage, clipboard, screenshots, and AI chat
- 🎯 **Flexible Commands** - Six matcher types: plain string, `regex`, `over`, `img`, `files`, and `window`
- 📦 **Two Distribution Forms** - ZPX (gzip asar) for production, local directory or HTTP URL for development
- 🔐 **Privilege Separation** - `window.ztools.internal` is only exposed to authorized plugins; bundled plugins do not get it automatically
- 🌍 **Cross-Platform** - Build once, run on Windows, macOS, and Linux

Plugin API type definitions are maintained in the [ztools-api-types](https://github.com/ZToolsCenter/ztools-api-types) submodule.

> 📖 **Upstream Documentation**: [ZTools Developer Documentation](https://ztoolscenter.github.io/ZTools-doc/). For local-edition differences, [AGENTS.md](./AGENTS.md) is authoritative.

## 🛠️ Tech Stack

- **Framework**: Electron 41 + Vue 3 + TypeScript
- **Build**: Vite + electron-vite + electron-builder
- **Database**: LMDB (high-performance key-value storage, routed per device/account)
- **State Management**: Pinia
- **Search Engine**: Fuse.js + pinyin-pro (pinyin support)
- **Translation**: Bergamot WASM + Firefox translation models
- **Native Modules**: C++ (Node-API)
  - Clipboard monitoring, window management, region screenshot, color picker, mouse monitoring
- **Input Hooking**: uiohook-napi (double-tap modifier detection)
- **Testing**: Vitest (unit) + Playwright Electron (E2E)

## 📁 Project Structure

```
CAI.Tools/
├── src/
│   ├── main/                    # Main process
│   │   ├── index.ts             # App entry, single-instance lock, runtime compatibility check
│   │   ├── appMain.ts           # Local-edition startup, window and API initialization
│   │   ├── managers/            # Window, plugin, clipboard, proxy, assembly coordination
│   │   ├── api/                 # IPC APIs (shared / renderer / plugin)
│   │   ├── core/                # Core capabilities
│   │   │   ├── appData/         # Local-edition data layout and isolated paths
│   │   │   ├── lmdb/            # Persistence and storage routing
│   │   │   ├── gitMirror/       # Git mirror protocol and plugin projection
│   │   │   ├── zbrowser/        # Browser automation
│   │   │   ├── mcpServer.ts     # MCP JSON-RPC server
│   │   │   └── httpServer.ts    # HTTP API server
│   │   └── utils/
│   ├── preload/                 # Main app preload (contextBridge)
│   ├── renderer/                # Renderer process (Vue)
│   └── shared/                  # Types shared between main and renderer
├── resources/
│   ├── lib/                     # Native modules (.node)
│   └── preload.js               # Plugin preload (not built by Vite)
├── internal-plugins/            # Bundled plugins (setting / system / string-tools)
├── ztools-api-types/            # Plugin API type definitions submodule
├── ztools-plugin-cli/           # Plugin development CLI submodule
├── docs/                        # HTTP API, provider development, sync implementation
├── tests/                       # Vitest unit tests and Playwright E2E
├── scripts/                     # Build and release scripts
└── AGENTS.md                    # Development rules and technical documentation
```

## 📚 Documentation

- [AGENTS.md](./AGENTS.md) - Development rules, architecture, IPC model, and API guidelines
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution workflow and commit conventions
- [changelog.md](./changelog.md) - Version history
- [docs/http-api.md](./docs/http-api.md) - HTTP API reference
- [docs/provider-development-guide.md](./docs/provider-development-guide.md) - AI provider development guide
- [internal-plugins/string-tools/README.md](./internal-plugins/string-tools/README.md) - String tools plugin guide

## 💻 Development

### Requirements

- Node.js >= 22 (CI uses 22)
- pnpm 11 (CI uses 11.18.0)
- macOS, Windows, or Linux development environment

### Getting the Source

1. Fork the repository
   - To contribute plugin types or the CLI, also fork [ztools-api-types](https://github.com/ZToolsCenter/ztools-api-types) and [ztools-plugin-cli](https://github.com/ZToolsCenter/ztools-plugin-cli)
2. Clone with submodules

```bash
git clone https://github.com/Caicy/CAI.Tools.git --recurse-submodules
```

### Development Commands

```bash
# Install dependencies
pnpm install

# Development mode (main process + setting plugin with hot reload)
pnpm dev
pnpm dev:main         # Main process only
pnpm dev:setting      # Setting plugin dev server only

# Type checking
pnpm typecheck        # All
pnpm typecheck:node   # Main process + preload
pnpm typecheck:web    # Renderer process

# Code quality
pnpm format           # Prettier formatting
pnpm lint             # ESLint check

# Testing
pnpm test             # Vitest unit tests
pnpm test:watch       # Watch mode
pnpm test:e2e         # Source-based Electron E2E (no packaging)

# Build
pnpm build            # Compile source only (includes typecheck and setting build)
pnpm build:win        # Package Windows app
pnpm build:mac        # Package macOS app
pnpm build:linux      # Package Linux app (host arch)
pnpm build:unpack     # Package without installer (for debugging)

# Submodules
pnpm sync-api-types   # Sync ztools-api-types definitions
```

### Testing Conventions

- E2E runs against source-built Electron; never package the app for tests, and do not run `electron-builder` or `pnpm build:unpack`
- Playwright starts the setting plugin dev server (`127.0.0.1:15177`) and an isolated Electron instance automatically
- Tests use temporary data directories and must never read or write the real `~/.cai-tools` or `~/.ztools`
- Electron E2E uses the bundled Chromium, so `playwright install chromium` is not required
- Screenshots and traces are written to `test-results/playwright`, which is not committed

### Debugging

- Main process: Press F5 in VS Code, or use `pnpm dev` to view terminal logs
- Renderer process: Press `Ctrl+Shift+I` (Windows) or `Cmd+Option+I` (macOS) to open developer tools
- Plugins: Click "Open DevTools" on the plugin page; production closed-source plugins cannot open it

## 🗺️ Roadmap

### Completed ✅

- [x] Quick app launch and pinyin search
- [x] Plugin system (UI + headless) with anonymous plugin market access
- [x] Clipboard history management
- [x] LMDB database with namespace isolation
- [x] Theme customization and custom global shortcuts
- [x] Separate plugins into independent windows
- [x] Super panel, floating ball, web quick-open
- [x] Offline translation (Bergamot WASM)
- [x] MCP server and HTTP API
- [x] ZBrowser automation
- [x] Self-configured AI providers and plugin AI chat
- [x] Login-free local edition: official account, payment, and cloud sync removed from the startup chain
- [x] Independent `.cai-tools` data root, rejecting upstream data probing and import
- [x] Manual upstream version notice
- [x] Git mirror protocol, plugin data projection, and AI credential isolation
- [x] Bundled string-tools plugin

### In Progress / Not Done 🚧

- [ ] Git automatic sync and multi-machine migration
- [ ] Pre-built macOS and Linux artifacts
- [ ] Plugin auto-update
- [ ] Full settings-page typecheck (22 pre-existing upstream baseline errors)

### Explicitly Not Provided ⛔

- Official account login, payments, official cloud sync (local-edition boundary, see above)

## 🐛 Issue Reporting

Having issues? Please report them in [Issues](https://github.com/Caicy/CAI.Tools/issues).

When submitting an issue, please include:

- Operating system version
- CAI.Tools version (settings page or `package.json`)
- Steps to reproduce
- Error logs (if any)

For generic upstream ZTools problems, report to [ZToolsCenter/ZTools](https://github.com/ZToolsCenter/ZTools/issues) instead.

## 📄 License

This project is licensed under the [MIT License](./LICENSE).

## 💝 Acknowledgments

- [ZTools](https://github.com/ZToolsCenter/ZTools) - Upstream project this fork is based on
- [uTools](https://u.tools/) - Source of inspiration
- [Electron](https://www.electronjs.org/) - Cross-platform desktop app framework
- [Vue.js](https://vuejs.org/) - Progressive JavaScript framework
- [LMDB](http://www.lmdb.tech/) - High-performance embedded database
- [Bergamot](https://github.com/browsermt/bergamot-translator) - Offline translation engine
