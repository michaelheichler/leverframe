<!-- gitnexus:start -->
# GitNexus Code Intelligence

GitNexus indexes this project as **leverframe** (17880 symbols, 50354 relationships, 904 execution flows).

> If the index is stale, run `node .gitnexus/run.cjs analyze --index-only` from the project root. It auto-selects an available runner. If `.gitnexus/run.cjs` does not exist yet, bootstrap with `npx`, `bunx`, or `pnpm dlx`. For example, use `bunx gitnexus@latest analyze` (npm 11 npx crash, #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`. Report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check. A zero means unseen, not unaffected. Re-run it. For regression review, use `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit. Never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol with care. MCP File omits axes. Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set does not prove that no callers use the symbol. It can also mean the index cannot resolve the callers (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Check with a text search before treating the symbol as safe to change or delete. Do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first. Text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows, needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis. Never read `UNKNOWN` as an all-clear. It means the walk cannot answer. This verdict requires checking by other means.
- NEVER rename symbols with find-and-replace. Use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/leverframe/context` | Codebase overview, check index freshness |
| `gitnexus://repo/leverframe/clusters` | All functional areas |
| `gitnexus://repo/leverframe/processes` | All execution flows |
| `gitnexus://repo/leverframe/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## Test isolation

Read `CALIBER_LEARNINGS.md` before development or QA. Set temporary `HOME` and `LEVERFRAME_HOME` before test imports or path resolution, and assert fixture write paths stay inside that directory. Keep the live Leverframe registry and credential store untouched unless the user requests a live configuration change.

## Runtime build output

Git ignores `dist/`. Commit source changes, never generated bundles. Run `pnpm build` before tests, CLI use or `pnpm check:package` in a fresh checkout. Packing and publishing build through `prepack`, and CI builds every matrix job before tests.
