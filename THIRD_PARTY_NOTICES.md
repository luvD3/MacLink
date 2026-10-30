# Third-party components

MacLink uses noVNC 1.7.0, primarily licensed under the Mozilla Public License 2.0.
The unmodified source is available at https://github.com/novnc/noVNC/tree/v1.7.0.
Its license notices, author list and additional component licenses are distributed in
`resources/third-party/noVNC` with this application.
No noVNC source files are modified by this project.
MacLink subclasses the ZRLE decoder, substitutes its inflater at build time,
and subclasses RFB to schedule the next framebuffer request earlier and
shorten the mouse movement interval while a regular mouse button is held,
and preserve accumulated wheel distance across coalesced input events.
The adapter depends on the internal interfaces of the pinned noVNC version.

The Apple precise-scroll message builder is adapted from Screon's AppleScroll
implementation (MIT), Copyright (c) 2026 Screon contributors.
Source: https://github.com/ledhcg/screon/blob/08e60a7c07cc914e75e0e2fb8eaee5facdf08a15/Sources/RFBKit/Protocol/AppleInputEvent.swift.
Its license is distributed in `resources/third-party/Screon/LICENSE`.

ZRLE decompression uses zlib-streams 1.4.0 (BSD 3-Clause), including zlib and
its additional component notices. The unmodified source and WASM binary are
available at https://github.com/gildas-lormeau/zlib-streams.
The full license file is distributed in `resources/third-party/zlib-streams/LICENSE`.

Electron includes Chromium, Node.js, and their third-party components. See
`LICENSE` and `LICENSES.chromium.html` in the application distribution.
React, React DOM and ws use the MIT license; their notices are in `resources/third-party`.

The Windows installer and Update.exe use Squirrel.Windows (MIT), built through
Electron Forge and electron-winstaller. Its license is distributed in
`resources/third-party/Squirrel.Windows/LICENSE`.
Source: https://github.com/Squirrel/Squirrel.Windows.

The repository does not grant a license to MacLink's original code yet.
Choose an appropriate project license before public redistribution.
