# OpenAI cache recovery design

Lower fresh input and plan allowance per resolved task across Leverframe's ChatGPT Plan workloads. Start with Home Assistant on Astra, where the November 19 snapshot recorded 21.05 million fresh input tokens. Keep Luna separate from Astra. The Luna sample ran at max effort and produced 157,334 output tokens in 34 requests. Retain Anthropic and OpenCode Go as route-specific comparisons.

## Global constraints

- Keep the Sign in with ChatGPT HTTP route at `store: false` and `stream: true`, with full input and no `previous_response_id`.
- Collect live samples during ordinary interactive tasks. Use local fixtures for automated checks.
- Preserve missing usage values as unknown and keep them distinct from zero.
- Compare the same provider route, model, credential scope, and effort within each experiment.
- Report weekly allowance from a fresh provider measurement. Keep modeled API dollars separate.
- Keep prompt text, tool schemas, raw session keys, response IDs, and credentials out of diagnostic artifacts.

## What the November 19 evidence establishes

Homelab produced 51 zero-read Astra requests with an unchanged outgoing prefix, and many requests followed their predecessor within 30 seconds. The normalized request fingerprints rule out a Leverframe tool or history rewrite for those comparisons. The upstream cause remains open. OpenAI describes `unavailable` as inconclusive. [OpenAI cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)

Home Assistant carried most of the fresh OpenAI input, and its running backend lacked the diagnostic flags. Local diagnostics now run by default on the Plan route. Each completed response carries the local prefix finding, its baseline scope and age, and the reported usage, including on Luna. Opt-in GPT-6.2 comparisons also record the upstream request ID when OpenAI returns one.

## Decision rules

- When final-wire prefixes differ often, fix the first demonstrated client-side change. Test append-only tool declarations for additions. Preserve the established sequence and start a new baseline on incompatible changes. Hold effort fixed while evaluating tool changes. [OpenAI prefix guide](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged)
- When stable-prefix zero reads persist on sequential same-scope requests, keep a redacted support sample. Include provider request IDs where available, UTC times, usage, and the local comparison result. Track the upstream outcome separately. Only test request pacing when real overlapping work shows a repeatable difference.
- Keep experiments with smaller contexts or different effort levels separate from prefix repair. Use cost per resolved task, verified task outcomes, and latency. Use a fresh provider meter observation for subscription effects. The [paired evaluation guide](../../local-retrieval.md) defines the pilot gate.
- Treat same-connection WebSocket continuation as a separate follow-up experiment once HTTP evidence supports the work. Verify the preview contract and retain authenticated-connection boundaries. [ChatGPT Plan preview](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- Audit Haiku and OpenCode Go using their own response counters. Keep the Anthropic cache write and cache read counts distinct. Use Go allowance when the provider supplies it. Routes with strong reads remain controls for this investigation.
