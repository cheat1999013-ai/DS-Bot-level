# Profile resource ownership

## Goal

The desktop app and standalone DS Bot expose two different profile layers with clear runtime effects. Users can see resources outside their selected layer and assign supported resources without silently moving existing data.

## DSH process profile

The active DSH profile is selected by the launcher. Its `package.json` owns the ordered bundle list and its patch owns process plugin configuration; the installed package files can remain in the DSH installation or profile dependency tree. DS Bot does not duplicate or install packages when assigning a Bot profile.

The app launcher passes its actual profile name before loading its bundles. DS Bot registers a separate official filesystem skill provider for that profile's `skills/` directory when the DSH skill service and provider package are present. Other launchers must supply the active profile explicitly. A file backed skill can be copied to the active profile after a user action, preserving the source and its local resources; file and folder name, size, collision and symlink checks run on the staged copy, and the target directory is rechecked before publication. The active registry must select the copied file before the UI claims it is in use. Project scoped skills can outrank this provider and cannot be copied with an activation promise.

MCP plugin instances and credentials stay in DSH's configured plugin layer. There is no implicit `mcp/` scanner in DSH. DS Bot's own MCP capabilities remain in its capability library and can be assigned per Bot. Arbitrary content has no implicit profile loading contract.

## Bot profile

`$DSH_HOME/bot/state.json` stores a named selection of existing skill, MCP and pack capability IDs, plus DSH plugin names as informational references. New plugin references must occur in a profile manifest or the live loader; manifest declarations do not prove installation. Missing legacy references and inactive references remain visible for correction. Applying a Bot profile replaces the Bot's selected capability set, saves a snapshot of what was applied and refreshes its private and group sessions. Editing the profile updates assigned Bots; clearing or deleting it removes only the snapshot, retaining later manually attached capabilities. A missing referenced capability blocks apply. The Bot profile does not mount or unload DSH plugins.

## Interface and boundaries

A native “Classify existing Bots” action creates one Bot Profile for every currently unassigned Bot, including Bots without capabilities. It copies each Bot's exact current capability names into its Profile and records the applied snapshot in one save; a second call does nothing. Existing assignments are preserved, and missing capabilities abort the entire operation before writing. Profile names derive from Bot names with deterministic collision suffixes. This is an explicit action, not an automatic migration on startup.

A native Settings page shows DSH profiles and their bundle lists, stored skill names with registry selection status, loaded skills with sources, process plugins absent from profile manifests, Bot profile editing and assignments, and unassigned DS Bot capabilities. DSH and Bot scope labels are explicit. The ordinary plugin manager remains the sole installer of DSH bundles. The `profiles` channel is readable under the normal read only lock; save/apply/delete/copy operations require the write path. The UI never exposes skill bodies or MCP secrets in its profile roster. Copying stages files outside the watched skill root, rejects links in the staged tree, then publishes the verified copy; the original stays in place.

## Verification

Test host create/apply/edit/clear/delete and session refresh with isolated state; exercise official filesystem discovery and body loading from a repository fixture; check the generated client bundle and package list. Test the channel write lock and the copy operation with an isolated project drive fixture. A real installed desktop window and the canonical smoke/web/desktop checks are separate acceptance gates, not implied by package unit tests.
