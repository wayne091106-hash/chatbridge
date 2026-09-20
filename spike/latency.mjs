import { OpenAICompatibleProvider } from "../dist/src/agent/providers/openai.js";
import { builtinTools, toolSpec } from "../dist/src/agent/tools.js";
const model = process.argv[2] ?? "z-ai/glm-5.3-flash";
const p = new OpenAICompatibleProvider({ name: "nim", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: process.env.NVIDIA_API_KEY, model, maxOutputTokens: 2048 });
const tools = builtinTools().map(toolSpec);
console.log("tool schema chars:", JSON.stringify(tools).length);
for (const [label, withTools, stream] of [["no tools", false, false], ["tools", true, false], ["tools+stream", true, true]]) {
  const t0 = Date.now(); let first = 0;
  const r = await p.complete({ messages: [{ role: "system", content: "You are a helpful agent." }, { role: "user", content: "List the files in the current directory." }], tools: withTools ? tools : undefined, onText: stream ? () => { first ||= Date.now() - t0; } : undefined });
  console.log(model, label, `${Date.now() - t0}ms`, "calls:", r.toolCalls.map((c) => c.name).join(","), "usage:", JSON.stringify(r.usage));
}
