# Media Preview

**Notice:** This extension is bundled with Visual Studio Code. It can be disabled but not uninstalled.

## Features

This extension provides basic preview for images, audio, video and PDF files.

### PDF documents

Open `.pdf` files (including uppercase extensions) in Editor, Simple, or Advanced mode to view them in the IDE. PDF Preview includes page navigation, selectable text, zoom, fit to width, rotation, and password-protected document support. The renderer is bundled for offline use. PDF content is read-only.

To test the PDF viewer, run `npm run build-preview` and `npm run test-pdf-preview` in this extension directory. The browser tests use Playwright Chromium; set `PDF_TEST_BROWSER` to an existing Chromium executable if needed. The encrypted test fixture is a blank PDF with password `preview-test`.

### Supported image file extensions

- `.jpg`, `.jpe`, `.jpeg`
- `.png`
- `.bmp`
- `.gif`
- `.ico`
- `.webp`
- `.avif`

### Supported audio formats

- `.mp3`
- `.wav`
- `.ogg`, `.oga`

### Supported video formats

- `.mp4` (does not support `aac` audio tracks)
- `.webm` (vp8 only)
