# Medcius plugin icon

The single snake and spear design was selected by the project owner on
2026-11-05. Its deep teal background and ivory mark are shared across light
and dark themes.

- `medcius-icon-source.png`: unchanged, generated source artwork.
- `medcius-icon-512.png`: 512 × 512 PNG for `interface.logo` and `logoDark`.
- `medcius-icon-128.png`: 128 × 128 PNG for `interface.composerIcon`.
- `../.claude-plugin/icon.png`: byte-identical 512 × 512 copy at Claude's
  conventional catalog icon location; no new manifest field is required.

Both delivery sizes were resized directly from the source with Pillow 12.0.0
using `Image.Resampling.LANCZOS` and PNG optimization. No crop, recoloring,
redrawing, or baked-in corner mask was applied. These are project-selected
delivery sizes; the bundled manifest validator does not mandate pixel sizes.

Paths in `.codex-plugin/plugin.json` are relative to the plugin root. Updating
the source repository does not by itself refresh an already installed host
cache; the installed plugin must load the updated package to display the icon.
