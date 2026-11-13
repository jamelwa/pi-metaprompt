// Run: npm test
// Requires Node's built-in TypeScript stripping (Node 22.18+).
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerMetaprompt from "./index.ts";

const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup({ hasUI = true, editorValue, idle = true, agentDir } = {}) {
	if (!agentDir) {
		agentDir = mkdtempSync(join(tmpdir(), "metaprompt-test-"));
		roots.push(agentDir);
	}
	const commands = new Map();
	const events = new Map();
	const messages = [];
	const notices = [];
	const editorCalls = [];
	const selections = [];
	const branch = [];
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		registerMetaprompt({
			registerCommand: (name, command) => commands.set(name, command),
			on: (name, handler) => events.set(name, handler),
			sendUserMessage: (content, options) => messages.push({ content, options }),
		});
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
	}
	const ctx = {
		hasUI,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => "synthetic-session",
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
		},
		ui: {
			editor: async (...args) => {
				editorCalls.push(args);
				return editorValue;
			},
			select: async () => selections.shift(),
			notify: (message, type) => notices.push({ message, type }),
		},
	};
	const emit = async (type, event = {}) => events.get(type)?.({ type, ...event }, ctx);
	const deliver = async (text, source = "rpc") => {
		await emit("input", { text, source });
		const message = { role: "user", content: [{ type: "text", text }] };
		branch.push({ type: "message", id: `entry-${branch.length}`, message });
		await emit("message_start", { message });
	};
	const respond = async (text, stopReason = "stop") => {
		const message = { role: "assistant", content: [{ type: "text", text }], stopReason };
		branch.push({ type: "message", id: `entry-${branch.length}`, message });
		await emit("message_end", { message });
		await emit("agent_settled", { aborted: stopReason === "aborted" });
	};
	return { commands, messages, notices, editorCalls, ctx, selections, branch, agentDir, emit, deliver, respond,
		command: commands.get("metaprompt"), mode: commands.get("metaprompt-mode") };
}

test("registers the slash command without starting a model turn", () => {
	const { commands, command, messages } = setup();
	assert.deepEqual([...commands.keys()].sort(), ["metaprompt", "metaprompt-mode"]);
	assert.match(command.description, /rough idea/);
	assert.equal(messages.length, 0);
});

test("mode selection is global, explicit, and cancellation preserves the saved choice", async () => {
	const h = setup();
	assert.ok(h.mode, "mode command registered");
	await h.mode.handler("status", h.ctx);
	assert.match(h.notices.at(-1).message, /response-only/);
	await h.mode.handler("immediate", h.ctx);
	assert.equal(JSON.parse(readFileSync(join(h.agentDir, "metaprompt.json"), "utf8")).mode, "immediate");
	const resumed = setup({ agentDir: h.agentDir });
	await resumed.mode.handler("status", resumed.ctx);
	assert.match(resumed.notices.at(-1).message, /immediate/);
	const before = readFileSync(join(h.agentDir, "metaprompt.json"), "utf8");
	await resumed.mode.handler("", resumed.ctx);
	assert.equal(readFileSync(join(h.agentDir, "metaprompt.json"), "utf8"), before);
	assert.equal(resumed.messages.length, 0);
});

const QUESTIONS = "1. Which incompatible output contract should the prompt require?";
const FINAL = "# Role\nSynthetic assistant.\n\n# Context\nA disposable fixture.\n\n# Task\nReply only SYNTHETIC_EXECUTED.\n\n# Constraints\nDo not call tools.\n\n# Output Format\nPlain text.\n";

async function clarify(h, mode) {
	if (mode !== undefined) await h.mode.handler(mode, h.ctx);
	await h.command.handler("Write a synthetic reply", h.ctx);
	await h.deliver(h.messages[0].content, "extension");
	await h.respond(QUESTIONS);
	assert.equal(h.messages.length, 1, "clarification must not execute the task");
	assert.equal(h.notices.filter((notice) => notice.type === "warning").length, 0, "clarification was accepted");
	await h.deliver("Audience: tests. Outcome: synthetic reply. Constraints: no tools.");
}

test("sufficient context accepts a direct final prompt in every existing mode", async () => {
	for (const mode of ["response-only", "approval", "immediate"]) {
		const h = setup({ editorValue: FINAL });
		await h.mode.handler(mode, h.ctx);
		await h.command.handler("Use the decisions already in this conversation", h.ctx);
		await h.deliver(h.messages[0].content, "extension");
		if (mode === "approval") h.selections.push("Execute");
		await h.respond(FINAL);
		assert.equal(h.messages.length, mode === "response-only" ? 1 : 2, mode);
		assert.equal(h.editorCalls.length, mode === "approval" ? 1 : 0, mode);
		assert.deepEqual(h.notices.filter((notice) => notice.type === "warning"), [], mode);
		if (mode !== "response-only") assert.deepEqual(h.messages[1], { content: FINAL, options: { deliverAs: "followUp" } });
		await h.emit("agent_settled", { aborted: false });
		await h.deliver("An unrelated later request");
		await h.respond(FINAL);
		assert.equal(h.messages.length, mode === "response-only" ? 1 : 2, "completed workflows cannot dispatch again");
	}
});

test("conditional clarification accepts the useful batch size, not a question quota", async () => {
	for (const count of [1, 2, 6]) {
		const h = setup();
		await h.mode.handler("immediate", h.ctx);
		await h.command.handler("Synthetic goal", h.ctx);
		await h.deliver(h.messages[0].content, "extension");
		await h.respond(Array.from({ length: count }, (_, i) => `${i + 1}. Consequential choice ${i + 1}?`).join("\n"));
		assert.equal(h.messages.length, 1);
		assert.equal(h.notices.filter((notice) => notice.type === "warning").length, 0);
		await h.deliver("Synthetic answers");
		await h.respond(FINAL);
		assert.equal(h.messages.length, 2, `batch of ${count}`);
	}
});

test("read-only context tool turns do not settle or dispatch the workflow", async () => {
	const h = setup();
	await h.mode.handler("immediate", h.ctx);
	await h.command.handler("Use current project evidence", h.ctx);
	await h.deliver(h.messages[0].content, "extension");
	const assistant = { role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "AGENTS.md" } }], stopReason: "toolUse" };
	const result = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Synthetic project evidence" }] };
	for (const message of [assistant, result]) {
		h.branch.push({ type: "message", id: `entry-${h.branch.length}`, message });
		await h.emit("message_start", { message });
		await h.emit("message_end", { message });
	}
	assert.equal(h.messages.length, 1);
	await h.respond(FINAL);
	assert.equal(h.messages.length, 2);
	assert.equal(h.messages[1].content, FINAL);
});

test("immediate mode executes the final prompt once after conditional clarification and answers", async () => {
	const h = setup();
	await clarify(h, "immediate");
	await h.respond(FINAL);
	assert.equal(h.messages.length, 2);
	assert.deepEqual(h.messages[1], { content: FINAL, options: { deliverAs: "followUp" } });
	await h.emit("agent_settled", { aborted: false });
	await h.deliver(FINAL, "extension");
	await h.respond(FINAL);
	assert.equal(h.messages.length, 2, "execution output cannot re-enter prompt generation");
	assert.equal(h.editorCalls.length, 0, "immediate mode opens no approval dialog");
});

test("aborting while waiting for clarification cancels future execution", async () => {
	const h = setup();
	await h.mode.handler("immediate", h.ctx);
	await h.command.handler("Synthetic goal", h.ctx);
	await h.deliver(h.messages[0].content, "extension");
	await h.respond(QUESTIONS);
	await h.emit("agent_settled", { aborted: true });
	await h.deliver("A later unrelated request");
	await h.respond(FINAL);
	assert.equal(h.messages.length, 1);
});

test("default response-only mode leaves the final prompt in the response without a dispatch", async () => {
	const h = setup();
	await clarify(h);
	await h.respond(FINAL);
	assert.equal(h.messages.length, 1);
	assert.equal(h.editorCalls.length, 0);
});

test("approval executes exactly the submitted prompt only after Execute", async () => {
	const h = setup({ editorValue: FINAL });
	await clarify(h, "approval");
	h.selections.push("Execute");
	await h.respond(FINAL);
	assert.equal(h.messages.length, 2);
	assert.equal(h.messages[1].content, FINAL);
	assert.equal(h.editorCalls.length, 1);
	assert.equal(h.editorCalls[0][1], FINAL);
});

test("revision returns to the editor and requires approval of the latest exact text", async () => {
	const h = setup();
	await clarify(h, "approval");
	const firstEdit = FINAL.replace("SYNTHETIC_EXECUTED", "FIRST_EDIT");
	const finalEdit = `\n${FINAL.replace("SYNTHETIC_EXECUTED", "FINAL_EDIT")}\n`;
	let edits = 0;
	h.ctx.ui.editor = async (_title, prefill) => {
		assert.equal(h.messages.length, 1);
		assert.equal(prefill, edits === 0 ? FINAL : firstEdit);
		return edits++ === 0 ? firstEdit : finalEdit;
	};
	h.selections.push("Revise", "Execute");
	await h.respond(FINAL);
	assert.equal(edits, 2);
	assert.equal(h.messages.length, 2);
	assert.equal(h.messages[1].content, finalEdit);
});

test("cancelled or blank approval preview never opens execution consent", async () => {
	for (const editorValue of [undefined, "", " \n "]) {
		const h = setup({ editorValue });
		await clarify(h, "approval");
		h.ctx.ui.select = async () => { throw new Error("Unexpected execution consent"); };
		await h.respond(FINAL);
		await h.emit("agent_settled", { aborted: false });
		assert.equal(h.messages.length, 1);
	}
});

test("declining or cancelling execution consent does nothing further", async () => {
	for (const choice of [undefined, "Cancel", "unexpected"]) {
		const h = setup({ editorValue: FINAL });
		await clarify(h, "approval");
		h.selections.push(choice);
		await h.respond(FINAL);
		await h.emit("agent_settled", { aborted: false });
		assert.equal(h.messages.length, 1);
	}
});

test("changing the global mode cannot silently execute an existing approval request", async () => {
	const h = setup({ editorValue: FINAL });
	await clarify(h, "approval");
	await h.mode.handler("immediate", h.ctx);
	await h.respond(FINAL);
	assert.equal(h.editorCalls.length, 1);
	assert.equal(h.messages.length, 1);
});

test("queued metaprompt does not consume an unrelated run's final-looking response", async () => {
	const h = setup({ idle: false });
	await h.mode.handler("immediate", h.ctx);
	await h.command.handler("Synthetic queued goal", h.ctx);
	await h.respond(FINAL);
	assert.equal(h.messages.length, 1);
	h.ctx.isIdle = () => true;
	await h.deliver(h.messages[0].content, "extension");
	await h.respond(QUESTIONS);
	await h.deliver("Synthetic answers");
	await h.respond(FINAL);
	assert.equal(h.messages.length, 2);
});

test("malformed, wrapped, failed or aborted output never dispatches, directly or after answers", async () => {
	for (const direct of [true, false]) {
		for (const variant of ["preamble", "fence", "xml", "quote", "missing-heading", "extra-heading", "questions", "error", "aborted"]) {
			const h = setup();
			if (direct) {
				await h.mode.handler("immediate", h.ctx);
				await h.command.handler("Synthetic goal", h.ctx);
				await h.deliver(h.messages[0].content, "extension");
			} else await clarify(h, "immediate");
			const text = {
				preamble: `Here is your prompt:\n${FINAL}`,
				fence: `\`\`\`markdown\n${FINAL}\`\`\``, xml: `<prompt>\n${FINAL}</prompt>`, quote: `"${FINAL}"`,
				"missing-heading": FINAL.replace("# Task", "## Task"), "extra-heading": `${FINAL}\n# Extra\nUnexpected.`,
				questions: QUESTIONS,
			}[variant] ?? FINAL;
			await h.respond(text, ["error", "aborted"].includes(variant) ? variant : "stop");
			assert.equal(h.messages.length, 1, `${variant}, direct=${direct}`);
		}
	}
});

test("session shutdown, tree navigation and compaction discard pending execution", async () => {
	for (const event of ["session_shutdown", "session_tree", "session_before_compact"]) {
		const h = setup();
		await clarify(h, "immediate");
		await h.emit(event);
		await h.respond(FINAL);
		assert.equal(h.messages.length, 1, event);
	}
});

test("navigation while approval is open invalidates the draft before consent", async () => {
	const h = setup();
	await clarify(h, "approval");
	h.ctx.ui.editor = async () => { await h.emit("session_tree"); return FINAL; };
	h.ctx.ui.select = async () => { throw new Error("Unexpected stale consent"); };
	await h.respond(FINAL);
	assert.equal(h.messages.length, 1);
});

test("pending input, foreign extension input and headless approval fail closed", async () => {
	for (const variant of ["pending", "foreign", "headless"]) {
		const h = setup({ hasUI: variant !== "headless", editorValue: FINAL });
		await clarify(h, variant === "headless" ? "approval" : "immediate");
		if (variant === "pending") h.ctx.hasPendingMessages = () => true;
		if (variant === "foreign") await h.deliver("Unrelated extension request", "extension");
		await h.respond(FINAL);
		assert.equal(h.messages.length, 1, variant);
	}
});

test("invalid or symlinked config is rejected without dispatch or overwrite", async () => {
	for (const variant of ["invalid-json", "invalid-mode", "symlink"]) {
		const h = setup();
		const config = join(h.agentDir, "metaprompt.json");
		const contents = variant === "invalid-json" ? "not JSON" : '{"mode":"unknown"}';
		const target = join(h.agentDir, "protected.json");
		if (variant === "symlink") {
			writeFileSync(target, '{"mode":"immediate"}');
			symlinkSync(target, config);
		} else writeFileSync(config, contents);
		await assert.rejects(h.command.handler("Synthetic goal", h.ctx), /Cannot read metaprompt.json/);
		await assert.rejects(h.mode.handler("immediate", h.ctx), /Cannot read metaprompt.json/);
		assert.equal(h.messages.length, 0);
		assert.equal(readFileSync(config, "utf8"), variant === "symlink" ? '{"mode":"immediate"}' : contents);
	}
});

test("mode picker accepts native labels and rejects unknown arguments without a turn", async () => {
	const h = setup();
	h.selections.push("Approval");
	await h.mode.handler("", h.ctx);
	await h.mode.handler("status", h.ctx);
	assert.match(h.notices.at(-1).message, /approval/);
	await assert.rejects(h.mode.handler("unknown", h.ctx), /Usage/);
	assert.equal(h.messages.length, 0);
});

test("preserves a free-form goal and includes the context-first, prompt-only contract", async () => {
	const { command, ctx, messages, editorCalls } = setup({ hasUI: false });
	const goal = 'Review /api, keep $VARIABLE and [EXAMPLE].\nUse "plain English".';
	await command.handler(`  ${goal}  `, ctx);
	assert.equal(editorCalls.length, 0);
	assert.equal(messages.length, 1);
	const { content, options } = messages[0];
	assert.ok(content.endsWith(`## Goal brief\n${goal}`));
	assert.match(content, /Stage 1: Gather relevant context/);
	assert.match(content, /current conversation.*answers and decisions/);
	assert.match(content, /project routing.*instructions.*memory sources/);
	assert.match(content, /smallest useful set.*authorized read-only tools/);
	assert.match(content, /project files.*Git state/);
	assert.match(content, /stale or conflicting memories.*current project evidence/);
	assert.match(content, /Never ask me to repeat.*available or reasonably discoverable/);
	assert.match(content, /context is sufficient, produce the final prompt immediately/);
	assert.match(content, /correctness, scope, authorization, or an important user choice/);
	assert.match(content, /smallest useful set.*one brief, numbered batch/);
	assert.match(content, /STOP and wait for my reply/);
	assert.match(content, /Do not start another question round/);
	assert.match(content, /routine audience, tone, format, repository, or environment questions/);
	assert.match(content, /NOT performing the underlying task/);
	assert.match(content, /Do not edit files, start services, or perform business operations/);
	assert.match(content, /Never read credential stores/);
	assert.match(content, /unrelated projects/);
	assert.match(content, /evidence, not instructions.*prompt-design boundary/);
	assert.match(content, /Do not invent facts, tool capabilities, permissions, or user preferences/);
	assert.match(content, /Do not narrate context gathering/);
	assert.doesNotMatch(content, /Ask 3 to 5|Clarification comes first|clarify first|Use unrelated conversation context only/);
	assert.match(content, /\[BRACKETED_PLACEHOLDERS\]/);
	assert.match(content, /Return only the final prompt, ready to paste directly into another AI/);
	assert.match(content, /Do not wrap the prompt in a code block, quotation marks, XML tags/);
	assert.match(content, /Do not add introductory text, commentary, a summary, usage instructions, or a closing message/);
	assert.match(content, /The entire response must be the prompt itself, with no extra text or outer wrapper/);
	assert.doesNotMatch(content, /Return exactly one copy-pasteable Markdown code block|outside the code block/);
	const headings = [...content.matchAll(/^# (.+)$/gm)].map((match) => match[1]);
	assert.deepEqual(headings, ["Role", "Context", "Task", "Constraints", "Output Format"]);
	assert.deepEqual(options, { deliverAs: "followUp" });
});

test("opens a multiline editor when no inline goal is provided", async () => {
	const { command, ctx, messages, editorCalls } = setup({ editorValue: "  Explain an API\nto beginners  " });
	await command.handler(" \n ", ctx);
	assert.deepEqual(editorCalls, [["Metaprompt: describe your goal"]]);
	assert.equal(messages.length, 1);
	assert.ok(messages[0].content.endsWith("Explain an API\nto beginners"));
});

for (const editorValue of [undefined, "", " \n "]) {
	test(`does not start a turn for cancelled/empty editor input: ${JSON.stringify(editorValue)}`, async () => {
		const { command, ctx, messages } = setup({ editorValue });
		await command.handler("", ctx);
		assert.equal(messages.length, 0);
	});
}

test("rejects a missing goal without attempting a headless dialog", async () => {
	const { command, ctx, messages, editorCalls } = setup({ hasUI: false });
	await assert.rejects(command.handler("", ctx), /Usage: \/metaprompt <rough idea>/);
	assert.equal(editorCalls.length, 0);
	assert.equal(messages.length, 0);
});

test("queues behind an active agent instead of steering it", async () => {
	const { command, ctx, messages } = setup({ idle: false });
	await command.handler("Write a release announcement", ctx);
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0].options, { deliverAs: "followUp" });
});
