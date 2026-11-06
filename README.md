# LUNA Markers

A proper marker list for [LUNA](https://www.uaudio.com/luna): add, name, color, recall and organize
timeline markers, styled to match LUNA's other Add Ons. It uses LUNA's own 16 marker colors.

Two flavors, same code:

| Add On | Opens as |
| --- | --- |
| **Markers** (`markers/`) | A panel in LUNA's secondary browser (Add Ons > Browsers > Markers) |
| **Markers Window** (`markers-window/`) | A floating window that shows while a session is open |

## Install

1. Download `Markers.lunaaddon` and/or `Markers Window.lunaaddon` from the
   [latest release](../../releases/latest).
2. Double-click the file to open it in LUNA (LUNA 3.1.1 or newer).

No other dependencies: everything the Add Ons need is bundled.

## Features and shortcuts

See [`markers/README.md`](markers/README.md) for the full feature list.

## Develop

`markers/` is the single source of truth; `markers-window/` is a generated copy of the shared page
files (LUNA refuses symlinks that leave an Add On's folder).

```sh
cd markers
npm install          # needs the LUNA Builder SDK (see devDependencies in package.json)
npm test
npm run pack         # syncs markers-window/ and packs both Add Ons
```
