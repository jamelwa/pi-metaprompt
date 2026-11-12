// Run: npm test
// Requires Node's built-in TypeScript stripping (Node 22.18+).
import assert from "node:assert/strict";
import test from "node:test";
import registerMetaprompt from "./index.ts";

function setup({ hasUI = true, editorValue, idle = true } = {}) {
	const commands = new Map();
	const messages = [];
	const editorCalls = [];
	registerMetaprompt({
		registerCommand: (name, command) => commands.set(name, command),
		sendUserMessage: (content, options) => messages.push({ content, options }),
	});
	const ctx = {
		hasUI,
		isIdle: () => idle,
		ui: {
			editor: async (...args) => {
				editorCalls.push(args);
				return editorValue;
			},
		},
	};
	return { commands, messages, editorCalls, ctx, command: commands.get("metaprompt") };
}

test("registers the slash command without starting a model turn", () => {
	const { commands, command, messages } = setup();
	assert.deepEqual([...commands.keys()], ["metaprompt"]);
	assert.match(command.description, /rough idea/);
	assert.equal(messages.length, 0);
});

test("preserves a free-form goal and includes the two-stage prompt contract", async () => {
	const { command, ctx, messages, editorCalls } = setup({ hasUI: false });
	const goal = 'Review /api, keep $VARIABLE and [EXAMPLE].\nUse "plain English".';
	await command.handler(`  ${goal}  `, ctx);
	assert.equal(editorCalls.length, 0);
	assert.equal(messages.length, 1);
	const { content, options } = messages[0];
	assert.ok(content.endsWith(`## Goal brief\n${goal}`));
	assert.match(content, /Ask 3 to 5 brief, numbered clarifying questions/);
	assert.match(content, /STOP and wait for my reply/);
	assert.match(content, /NOT performing the underlying task/);
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
