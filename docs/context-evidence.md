# Context evidence

Leverframe can shorten a later tool result when its successful text output exactly repeats an earlier result from the same tool and input. Both tool-call pairs remain in the request. The replacement includes a reference and an exact retrieval command, and must reduce both serialized bytes and estimated input tokens.

Instructions, error results and unrelated message content remain intact. Results containing images or other non-text data stay unchanged. Unknown context limits, incomplete tool calls, signed thinking and client-managed history retain the original request. Failed storage or validation also retains the original.

## Retrieve a source

Copy the command from the replacement text. Its form is:

```sh
leverframe evidence get '<session-id>' '<reference>'
```

The command prints the original tool text. It requires the original session and a valid opaque reference. Another session cannot retrieve that record.

The proxy and gateway also expose `POST /v1/leverframe/evidence` with a JSON body containing `sessionId` and `reference`. Use the configured proxy token or gateway password. This endpoint accepts only a local Host and loopback peer, and returns successful content with `Cache-Control: no-store`.

## Storage limits

Evidence uses encrypted, owner-only storage under Leverframe's application home. Live identical content within a session reuses its reference, including after a restart, without extending its original expiry. Records expire after 30 days. Supported reads and writes prune authenticated expired files. A stopped application cannot perform cleanup.

The default storage cap is 32 MiB. Set `LEVERFRAME_EVIDENCE_MAX_BYTES` to a positive integer byte limit to change it. A full store rejects new evidence and keeps the current request unchanged. It does not evict live references to make room.

The reduction estimate does not establish billed savings. Cache behavior, actual provider usage and reference retrieval can affect the session's total cost. This deterministic stage needs no model summary call.
