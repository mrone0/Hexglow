# Hexglow minimal OKF knowledge seed

These are **unverified placeholders**, not a complete or authoritative game corpus. The champion registry intentionally includes only Ahri and Garen; it does not claim complete roster coverage. `custom-example` is not a real augment.

The Rust backend embeds these three Markdown documents and the registry at compile time. On the first explicit knowledge command, it copies seeds into the app data directory's `knowledge` tree only if that tree and the sibling `.knowledge-seeded-v1` marker do not exist. The marker is written before copying: interruptions may leave a partial seed, but deleted documents are never silently restored. Existing trees are never merged with defaults. Nothing loads at application startup.

## Profile

Root YAML fields: `title`, `description`, `type` (`Champion` or `Augment`), `tags` (string list), `status` (`draft`, `stable`, or `deprecated`). `hexglow` contains `schema_version: 1`, `mode: hextech-aram`, `patch` (quoted string recommended), `champion_id` or `augment_id`, `aliases` (string list), and optional `game_id` (null, string, or unsigned integer). Unknown keys, Markdown, and original formatting are retained exactly on save. Verification is separate metadata in `verified`, not a lifecycle status; any verification declaration is not backend certification.

Paths are `champions/<id>.md` and `augments/<id>.md`, lowercase ASCII letters/digits/hyphens only. IDs must match the filename after case normalization; champion IDs must occur in the small bundled registry. IDs, type, and existing game ID cannot be changed by save. Champions cannot be deleted. Duplicate same-kind titles, aliases, and IDs are rejected on save; externally-created ambiguity is never resolved arbitrarily.

Required headings (level one `#` or level two `##`):

- Champion: 基础机制 / 常见打法 / 海克斯搭配 / 注意事项
- Augment: 完整效果 / 触发条件 / 限制与例外 / 相关交互

Root generated index has `okf_version: '0.2'` frontmatter; category indexes have no frontmatter. Only registered profile documents are indexed. Local Markdown links use relative paths such as `../augments/custom-example.md`. Missing links warn rather than block. Raw HTML and code are stored as inert text; a preview consumer must disable HTML execution.

## Limits and storage

256 KiB UTF-8 per file; 2,000 documents; three bounded backups per document in `.backups`. Writes use same-directory exclusive temporary files, flush/sync, then atomic rename. Symlinks and traversal are rejected; this is not a defense against a privileged external process racing filesystem operations. Deletion backs up the old content and reports referring document paths.

Retrieval returns at most 16 whole documents and 64 KiB total text. It matches normalized exact IDs, titles, or aliases, never substring matches or candidate effect descriptions. Own champion and candidate augments are mandatory; other champions and their augments are optional. One linked hop is included within the same budget. Draft/patch uncertainty is explicit in warnings; omitted mandatory documents appear in `missing`. FNV-1a 64-bit content hashes and sorted fingerprints are deterministic cache hints, not cryptographic authentication.

## Commands

- `knowledge_list({kind})` → `{documents:[{path,title,kind,status,patch}],root}`
- `knowledge_read({path})` → `{path,content}`
- `knowledge_validate({kind,path,content})` → `{valid,errors,warnings}` (syntax/profile validation; filesystem checks occur on save)
- `knowledge_save({kind,path,content})` → `{path,valid,warnings}`
- `knowledge_delete({path})` → `{deleted:true,warnings:[referringPath]}`
- `knowledge_retrieve({context})` → `{documents:[{path,title,content,hash}],missing,warnings,fingerprint}`

All I/O commands reject with an error string on failure. Validation returns diagnostics without throwing. Context accepts `ownChampion`, `champion`, or `own_champion`, or `players` plus `ownPlayerId`; `candidates`, `candidateAugments`, `augments`, `selectedAugments`, player `augments`, and optional `opponents`. Champion objects accept `champion`, `championName`, `championId`, `champion_id`, or `rawChampionName`; `game_character_displayname_Ahri` is supported. Candidate objects use exact `name`/`title`/ID; their supplied description is not verified knowledge.
