# pi-metaprompt

A Pi slash command that turns a rough idea into a self-contained prompt for another AI.

## Install

With Git access to this repository:

```sh
pi install git:github.com/jamelwa/pi-metaprompt
```

Run `/reload` in an existing Pi session after installation. If you previously copied the extension into `~/.pi/agent/extensions/metaprompt/`, keep only one installation to avoid duplicate commands.

## Use

```text
/metaprompt Write a technical proposal for migrating our API
```

Or use `/metaprompt` without arguments to open a multiline editor. Cancelling or submitting an empty editor does not start a model turn. Non-interactive callers must provide the idea inline.

1. Pi asks 3–5 brief clarifying questions about the outcome, audience, tone, constraints, and output format.
2. Answer normally in the same conversation, or say **draft now** to skip clarification.
3. The model is instructed to return only the final prompt, with no surrounding code fences, wrappers, preamble, or closing commentary.

The prompt uses **Role**, **Context**, **Task**, **Constraints**, and **Output Format** headings, with `[BRACKETED_PLACEHOLDERS]` for reusable inputs or unresolved details.

The extension uses the current Pi model and session; it needs no separate API key or runtime dependencies. If Pi is busy, the request queues as a follow-up rather than interrupting ongoing work. It instructs the model to design the prompt without executing the underlying task; it does not change tool permissions or provide a security sandbox.

## Test

Requires Node.js 22.18 or newer for built-in TypeScript stripping. No dependency installation is needed:

```sh
npm test
```

The offline tests cover command registration, free-form goal preservation, prompt instructions, editor input and cancellation, headless validation, and follow-up delivery. These tests validate the command and its instructions, not actual model compliance. Native extension loading and dispatch were also checked with Pi 1.5.2.
