# Local reviewer policy

Current reviewer: the newest available Gemini **Flash** from the live Windows
Antigravity `agy models` catalog. No model version is pinned. Later, use the
newest available Claude **Sonnet** only after quota recovery is verified through
an exposed read-only status. Do not test recovery with a model invocation.

The review itself runs manually through the installed Windows Antigravity CLI,
using the user's existing session, an explicitly selected catalog model, and
only the fix diff plus necessary technical code. Do not copy credentials or
send private notes. Keep the CLI runtime `init.model` evidence and reviewer
output; reject substitution or missing confirmation.

GitHub Actions has no connection to this PC or its login. The `AI Review`
workflow only checks maintainer-recorded local evidence; it does not run a
hosted Gemini integration, invoke Claude, create credentials, or verify quota.
Evidence is an attestation, not a cryptographically authenticated AI report.
The exact snapshot commit/tree and file hashes bind the complete reviewed patch,
including the workflow, validator and policy. Only the evidence JSON may change
after that snapshot. The baseline must equal the PR base commit. A moving base
requires a fresh review. Evidence does not authenticate the reviewer: a malicious
author can fabricate this attestation or edit the PR-controlled validator. Normal
maintainer review and existing security/build checks remain necessary.
Absent evidence, unresolved findings, an unverified model, or extra source
changes fail the evidence check. Existing build/test workflows stay intact.

To change reviewer family later, change `active_family` in
`.github/ai-review-policy.json` to `claude-sonnet`, refresh the live catalog,
record read-only quota recovery, and perform a fresh local review. Never change
the family just because a preferred model is unavailable. Policy and workflow
changes are ordinary reversible commits; do not alter branch protection or
account/security settings. Parent performs the normal merge.
