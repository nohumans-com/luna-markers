# Markers

A marker list for LUNA. Opens as a panel in LUNA's secondary browser (Add Ons > Browsers), or as a
floating window (the `markers-window` Add On). Look and feel follow MIDI Learn (`luna-skin.css`).

## Features

- **List:** number, color, name and comment, location, and length to the next marker. The marker
  the playhead is in is marked; Follow keeps it in view during playback.
- **Add and recall:** `M` or **+ Marker** drops a marker at the playhead and opens its name for
  typing. Click a row to move the playhead there (**Click to locate**). `.` `1` `2` `.` recalls
  marker 12; `[` and `]` step to the previous or next marker.
- **Edit:** double-click a name or location to edit it. Locations accept `5|3|240` or `1:30.5`.
  The inspector has name, comments, color and nudge (bar, beat, 1/16, tick).
- **Colors:** LUNA's own 16 marker colors. New markers cycle
  through LUNA's colors the way LUNA does.
- **Positions:** Bars / Time toggle for the list, clock and editor.
- **Ranges:** Select between (edit selection across all tracks) and Loop between a marker and the next.
- **Organize:** filter, Pos / A-Z sort, Renumber (auto-named markers only), Clear all, multi-select,
  duplicate, delete.
- **Undo:** bulk edits (color, nudge, delete, renumber) are one undo step.

## Develop

```sh
npm install
npm test                 # logic against Luna.MockEngine, no LUNA needed
npx ua-builder serve     # http://localhost:8790/ (LUNA running); add ?demo for an in-page mock session
npx ua-builder install   # Add Ons > Browsers > Markers
npm run pack
```

`logic.js` holds everything testable (no DOM); `main.js` renders and wires events.
