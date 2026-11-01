# Model summaries

Model summaries start off. Deterministic duplicate reduction can still run while this switch stays off.

Run `leverframe providers`, open **Account pool settings**, and choose **Configure summary engine and lifetime spending limit**. The API adapter accepts `openai:<model-id>` or `anthropic-api:<model-id>` and reads the selected provider's key from `LEVERFRAME_SUMMARY_API_KEY`. Enabling this engine sends selected older tool groups to that provider.

Enter the lifetime budget in USD, both maximum rates in USD per million tokens, and the source and date you used to verify those rates. Monetary inputs accept up to six decimal places. Leverframe keeps integer accounting internally. It does not independently verify your rate card or infer a free price from missing metadata.

## What can change

The stage summarizes only older completed successful text tool groups that contain no mixed prose. It keeps ordinary user and assistant prose, instructions, decisions, errors and recent groups intact. Unsupported histories keep their existing safe representation.

Before applying a summary, Leverframe checks its format, source coverage, tool boundaries, original evidence and lower estimated main input. The summary remains user-level data. Its references include commands for retrieving encrypted originals. These checks establish protocol and coverage safety, while the selected model still determines summary quality.

Matching route, engine, policy, source identity and token bounds can reuse a cached summary. Reuse adds no model call or spending charge. Changed or expired evidence cannot authorize stale reuse.

## Lifetime spending

The limit applies across requests and restarts. Changing engine or toggling summaries does not reset the ledger. Leverframe reserves the bounded maximum call cost before dispatch and settles valid known usage at your configured maximum rates. Malformed output still carries known usage through settlement. Missing usage, cancellation and abandoned calls retain the maximum reservation.

Turning summaries off or lowering the limit prevents new reservations. Already queued bounded calls may finish. The ledger tracks conservative charges at the rates you supplied, so actual provider billing can differ.

A rejected or failed summary keeps the request entering that stage, including any independently validated duplicate reduction. It does not change the main model or lower its effort, and auxiliary calls disable SDK retries.
