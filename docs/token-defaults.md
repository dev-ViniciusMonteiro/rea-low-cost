# Lean token defaults

Every MCP session lists all of REA's tools to the model, and most hosts put a
tool's description and input schema in context. The production `rea mcp`
entrypoint therefore advertises the lean presentation unless the caller asks
for the complete one.

| Setting                         | Production default | Restore the complete form |
| ------------------------------- | ------------------ | ------------------------- |
| `REA_MCP_INPUT_SCHEMA_PROFILE`  | `compact`          | `full`                    |
| `REA_MCP_OUTPUT_SCHEMA_PROFILE` | `off`              | `full`                    |
| `binary_session` `detail` input | `summary`          | `"detail": "full"`        |

- `compact` keeps every parameter and constraint, without nested annotation
  prose; each tool schema stays within 13 KiB.
- `off` omits output contracts from `tools/list`. REA still validates every
  successful result against its canonical contract and returns complete
  `structuredContent`.
- `summary` keeps capability sets only for available deep-analysis providers
  and empties provider `diagnostics`. Each provider's status, code and reason
  are unchanged, so the caller still learns why a provider is unavailable.

Library callers of `createServer` keep the full presentation when the
variables are unset. `rea mcp doctor` applies the same production defaults when
it computes the expected catalog.

## Measured effect

REA 6.5.0, 207 tools, `node scripts/bench-mcp-tokens.mjs`. Tokens are
estimated at 4 characters per token.

| What the client receives                           | Before       | After       |
| -------------------------------------------------- | ------------ | ----------- |
| `tools/list` message                               | 3,092,277 B  | 214,964 B   |
| Model-visible tool text (name, description, input) | ~196k tokens | ~44k tokens |
| `binary_session` text, no target                   | 64,580 B     | 31,459 B    |

The compact catalog digest is computed once per process, so the shared daemon
does not pay it again for each new connection.
