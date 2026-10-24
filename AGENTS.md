# Maintenance and release checklist

This is an existing, published Windows Cortico World extension. Read README.md and
docs/DESIGN.md before changes. Preserve the package name, `netease-music` World ID,
existing `music_` tools and event names: they are public compatibility contracts.
Use World for player I/O and comment lookup; do not edit Persona, emotion or Memory.

- Read the current official Cortina AGENTS.md and applicable Cortico World documentation.
- Record the actual Cortina/Core commits and target host version in release evidence.
- Run `npm run verify` (local checks), then `npm run check-official -- <Cortico checkout>`.
  The second command runs the complete official describe/check CLIs; the first does not.
- API must match the World contract printed by the complete check. Regenerate describe.json.
- Review Tags and Before publishing output; keep all applicable notice/warning tags.
- Keep a CHANGELOG section matching package version, Windows os restriction and icon assets.
- Test withdrawn versus consumed requests, configuration changes, stale metadata and process
  termination failure. Do not remove deduplication merely to fix a withdrawn request.
- Inspect `npm pack --dry-run`; exclude credentials, local deployment and review/reference data.
- Set CORTICO_CHECKOUT for `npm publish`; prepublishOnly requires the full release gate.
- Publishing or changing the running user instance needs explicit user authorization.
- Report automated loading separately from witnessed real pet speech; never claim the latter
  based only on unit tests or dry mount. Save a local checkpoint and release evidence.
