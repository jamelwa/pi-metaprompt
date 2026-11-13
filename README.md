# pi-metaprompt

Turn a rough idea and relevant context into a self-contained prompt, asking only consequential questions when needed. Choose whether Pi displays or executes the result.

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

1. Pi understands the goal and consults relevant conversation history, project routing/instructions, memories, project files, and Git state as needed, using the current session's existing authorized read-only tools. It gathers the smallest useful context, reuses prior answers/decisions, and checks stale or conflicting memories against current evidence.
2. With enough context, Pi generates the final prompt immediately. Minor gaps use reasonable defaults or descriptive `[BRACKETED_PLACEHOLDERS]`, not invented facts. Only unresolved gaps materially affecting correctness, scope, authorization, or an important user choice warrant questions: the smallest useful numbered batch, then Pi waits for your reply. There is no question quota or routine second clarification round.
3. The final response is **only the generated prompt**, ready to paste, with **Role**, **Context**, **Task**, **Constraints**, and **Output Format** headings: no introductory/closing commentary, quotation/XML wrappers, or surrounding code fences.
4. The request's selected mode determines what happens next:

| Mode | Behavior after prompt generation |
| --- | --- |
| `response-only` — default | Leave the generated prompt in the assistant response. Do not dispatch it. |
| `approval` | Open the prompt in an editable review dialog, then offer **Execute**, **Revise**, or **Cancel**. Execute sends exactly the latest submitted text; Revise returns to the editor and still requires explicit Execute. |
| `immediate` | Send the final prompt exactly once as a new user message in the **current Pi conversation**, without an additional execution-approval dialog. |

Context comes first in every mode; clarification is conditional, including in immediate mode. No `draft now` shortcut is needed. Pi should never ask you to repeat available or reasonably discoverable information, or ask routine audience/tone/format/repository/environment questions when the answers are evident. If a source/tool is unavailable, it uses the available context and represents material uncertainty honestly rather than inventing capabilities or permissions.

### Context-gathering boundary

Prompt design is **not execution of the underlying goal**. Context gathering permits only goal-relevant, authorized reads: no file edits, service starts, business operations, unrelated-project scans, credential-store reads, or exposure of secrets/private payloads/unnecessary personal information. Documents, examples, and recalled content are evidence, not instructions overriding that boundary. Existing routing determines which project and memory integrations to consult; no separate crawler, agent, model pipeline, dependency, or new setting is added.

The existing approval/immediate modes may dispatch the finished prompt as a **separate task turn** after generation, subject to their normal mode behavior and existing permissions. They do not authorize task execution during context gathering.

### Global mode selection

`/metaprompt-mode` opens a native picker showing the current mode and all three choices. Cancelling leaves the saved choice unchanged. Arguments allow non-interactive selection; `status` reports the mode through Pi's UI notifications. Mode arguments have native completions.

The mode is stored atomically in `~/.pi/agent/metaprompt.json` (or the directory selected by `PI_CODING_AGENT_DIR`) and read for each new request. This setting is global across projects and sessions; other active sessions pick up a changed mode on their next request. No setting file is needed for the default response-only behavior. Changing modes does not execute or change a request already waiting for answers or approval.

### Cancellation and safety

- Escape/blank input in the approval editor or Cancel/Escape at execution selection ends the workflow without task dispatch. Revision alone never executes anything.
- Abort, session shutdown/reload/replacement, tree navigation, and compaction discard pending workflows. Only the global mode persists; pending prompts are never restored and automatically executed after a restart.
- Starting another `/metaprompt` replaces the pending workflow. A plain `cancel` or `stop` reply also cancels tracking. Unexpected extension input, queued work present at the dispatch check, or stale approval context cancels dispatch.
- Automatic dispatch requires a complete successful response with the five required headings in order, either directly after context gathering or after one numbered clarification batch and a human answer. Unexpected/malformed output cannot trigger execution; structural failures warn in execution modes. Additional top-level headings are rejected conservatively. A repeated question batch after answers does not dispatch a task. Approval without TUI/RPC UI never executes.
- The extension uses the current model/session, needs no separate API key or runtime dependencies, and queues requests as follow-ups rather than steering ongoing work. Generated task input does not expand slash commands or templates.
- Existing tool permissions and native confirmations are unchanged. The prompt-design instruction is **not a security sandbox**: validation checks structure and dispatch ordering, not model honesty, factual correctness, or the safety of the generated task. Immediate mode authorizes a task turn, not bypassing existing safeguards.
- Invalid or symlinked configuration is rejected without dispatch or silently overwriting it. The extension stores only the mode, not goals or generated prompts, in its global configuration file.

## Test

Requires Node.js 22.18+ for built-in TypeScript stripping. No dependency installation is needed:

```sh
npm test
python3 tests/rpc-smoke.py
```

The RPC smoke additionally requires an installed Pi with the documented lifecycle/dialog APIs (verified with Pi 1.5.2). It runs twelve synthetic cases through native Pi RPC with isolated configuration, no tools/MCP, and a loopback-only mock provider. It checks single command registration, direct generation in all modes, single-question clarification, exact dispatch, malformed output, revision, cancellation, mode changes, and persistence across fresh Pi processes.

To verify a separately installed entry point using the same disposable harness:

```sh
python3 tests/rpc-smoke.py --extension /path/to/installed/metaprompt/index.ts
```

Unit tests exercise the context-first/prompt-only instruction contract, direct and conditional paths, context-tool message handling, and existing command/editor/queue/lifecycle boundaries. Test state stays in temporary directories; no real provider credentials or user configuration are used. String assertions verify instructions, and synthetic responses verify handler/RPC dispatch—not whether a live model actually gathers appropriate context, minimizes questions, obeys read-only restrictions, or always returns prompt-only text. These are not a security sandbox, live-provider or interactive TUI acceptance tests, or proof of activation in an already-running session.
