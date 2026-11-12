# pi-metaprompt

Turn a rough idea into a clarified prompt, then choose whether Pi displays or executes it.

## Install

```sh
pi install git:github.com/jamelwa/pi-metaprompt
```

Run `/reload` in an existing Pi session after installation. Keep only one installation: do not load both the Git package and a manual copy under `~/.pi/agent/extensions/metaprompt/`.

## Use

```text
/metaprompt Write a technical proposal for migrating our API
/metaprompt-mode
/metaprompt-mode response-only
/metaprompt-mode approval
/metaprompt-mode immediate
/metaprompt-mode status
```

`/metaprompt` without arguments opens a multiline goal editor. Cancelling or submitting blank text starts no model turn. Headless callers must provide the goal inline.

1. Pi asks **3–5 numbered clarification questions**. Answer normally in the same conversation.
2. Pi generates the final prompt with **Role**, **Context**, **Task**, **Constraints**, and **Output Format** headings, without an outer wrapper or commentary.
3. The request's selected mode determines what happens next:

| Mode | Behavior after clarification and prompt generation |
| --- | --- |
| `response-only` — default | Leave the generated prompt in the assistant response. Do not dispatch it. |
| `approval` | Open the prompt in an editable review dialog, then offer **Execute**, **Revise**, or **Cancel**. Execute sends exactly the latest submitted text; Revise returns to the editor and still requires explicit Execute. |
| `immediate` | Send the final prompt exactly once as a new user message in the **current Pi conversation**, without an additional execution-approval dialog. |

Clarification is mandatory in every mode; immediate mode does not skip it. The earlier `draft now` clarification shortcut no longer applies. Unresolved details are represented as descriptive `[BRACKETED_PLACEHOLDERS]` in the generated prompt rather than invented facts.

### Global mode selection

`/metaprompt-mode` opens a native picker showing the current mode and all three choices. Cancelling leaves the saved choice unchanged. Arguments allow non-interactive selection; `status` reports the mode through Pi's UI notifications. Mode arguments have native completions.

The mode is stored atomically in `~/.pi/agent/metaprompt.json` (or the directory selected by `PI_CODING_AGENT_DIR`) and read for each new request. This setting is global across projects and sessions; other active sessions pick up a changed mode on their next request. No setting file is needed for the default response-only behavior. Changing modes does not execute or change a request already waiting for answers or approval.

### Cancellation and safety

- Escape/blank input in the approval editor or Cancel/Escape at execution selection ends the workflow without task dispatch. Revision alone never executes anything.
- Abort, session shutdown/reload/replacement, tree navigation, and compaction discard pending workflows. Only the global mode persists; pending prompts are never restored and automatically executed after a restart.
- Starting another `/metaprompt` replaces the pending workflow. A plain `cancel` or `stop` reply also cancels tracking. Unexpected extension input, queued work present at the dispatch check, or stale approval context cancels dispatch.
- Automatic dispatch requires a complete successful response with the five required headings in order, after the clarification questions and a human answer. Unexpected/malformed output is left visible with a warning and no automatic execution. Additional top-level headings are rejected conservatively. Approval without TUI/RPC UI never executes.
- The extension uses the current model/session, needs no separate API key or runtime dependencies, and queues requests as follow-ups rather than steering ongoing work. Generated task input does not expand slash commands or templates.
- Existing tool permissions and native confirmations are unchanged. The prompt-design instruction is **not a security sandbox**: validation checks structure and dispatch ordering, not model honesty, factual correctness, or the safety of the generated task. Immediate mode authorizes a task turn, not bypassing existing safeguards.
- Invalid or symlinked configuration is rejected without dispatch or silently overwriting it. The extension stores only the mode, not goals or generated prompts, in its global configuration file.

## Test

Requires Node.js 22.18+ for built-in TypeScript stripping. No dependency installation is needed:

```sh
npm test
python3 tests/rpc-smoke.py
```

The RPC smoke additionally requires an installed Pi with the documented lifecycle/dialog APIs. It runs nine synthetic cases through native Pi RPC with isolated configuration, no tools/MCP, and a loopback-only mock provider. It covers all modes, exact dispatch, revision, cancellation, mode changes, mandatory clarification, and persistence across fresh Pi processes.

To verify a separately installed entry point using the same disposable harness:

```sh
python3 tests/rpc-smoke.py --extension /path/to/installed/metaprompt/index.ts
```

Unit tests exercise registered commands and lifecycle boundaries. Test state stays in temporary directories; no real provider credentials or user configuration are used. These checks establish the exercised handler/RPC contracts, not real-provider compliance, interactive TUI keyboard/rendering behavior, or activation in an already-running session.
