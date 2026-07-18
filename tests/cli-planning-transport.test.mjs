import assert from "node:assert/strict";
import test from "node:test";

import { CliPlanningTransport } from "../dist/ai/cliPlanningTransport.js";

const provider = {
  id: "codex",
  label: "Fake CLI",
  command: process.execPath,
  buildArgs() {
    return [
      "-e",
      "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'assistant',text:input}));console.log(JSON.stringify({type:'done'}));});",
    ];
  },
  buildStdin(prompt) {
    return prompt;
  },
  extractAssistantText(event) {
    return event?.type === "assistant" ? event.text : "";
  },
  isTerminalEvent(event) {
    return event?.type === "done" ? "completed" : null;
  },
};

test("CLI planning transport returns provider assistant text without a resumable session", async () => {
  const output = [];
  const transport = new CliPlanningTransport({ workspace: process.cwd(), totalTimeoutMs: 5_000, idleTimeoutMs: 2_000 });
  const result = await transport.run({
    provider,
    prompt: "exact-plan",
    signal: new AbortController().signal,
    onOutput: (text) => output.push(text),
  });
  assert.equal(result, "exact-plan");
  assert.deepEqual(output, ["exact-plan"]);
});

test("CLI planning transport uses the provider stdin encoding", async () => {
  const encodedProvider = {
    ...provider,
    buildStdin(prompt) {
      return `encoded:${prompt}`;
    },
  };
  const transport = new CliPlanningTransport({ workspace: process.cwd(), totalTimeoutMs: 5_000, idleTimeoutMs: 2_000 });

  const result = await transport.run({
    provider: encodedProvider,
    prompt: "exact-plan",
    signal: new AbortController().signal,
    onOutput: () => {},
  });

  assert.equal(result, "encoded:exact-plan");
});

test("CLI planning transport streams large prompts over stdin instead of process arguments", async () => {
  const prompt = "large-snapshot-".repeat(8_000);
  const transport = new CliPlanningTransport({ workspace: process.cwd(), totalTimeoutMs: 5_000, idleTimeoutMs: 2_000 });

  const result = await transport.run({
    provider,
    prompt,
    signal: new AbortController().signal,
    onOutput: () => {},
  });

  assert.equal(result, prompt);
});

test("CLI planning transport fails instead of falling back after a provider error", async () => {
  const failedProvider = {
    ...provider,
    buildArgs() {
      return ["-e", "console.log(JSON.stringify({type:'failed'}));process.exit(1)"];
    },
    isTerminalEvent(event) {
      return event?.type === "failed" ? "failed" : null;
    },
  };
  const transport = new CliPlanningTransport({ workspace: process.cwd(), totalTimeoutMs: 5_000, idleTimeoutMs: 2_000 });
  await assert.rejects(
    transport.run({ provider: failedProvider, prompt: "x", signal: new AbortController().signal, onOutput: () => {} }),
    /planning provider failed/i,
  );
});
