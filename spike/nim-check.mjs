import { OpenAICompatibleProvider } from "../dist/src/agent/providers/openai.js";
const models = process.argv.slice(2);
const tools = [{ name: "get_weather", description: "Get weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
for (const model of models) {
  const p = new OpenAICompatibleProvider({ name: "nim", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: process.env.NVIDIA_API_KEY, model, maxOutputTokens: 1024, timeoutMs: 90000 });
  const t0 = Date.now();
  try {
    let streamed = "";
    const r = await p.complete({ messages: [{ role: "system", content: "Use tools when needed." }, { role: "user", content: "What's the weather in Taipei? Use the tool." }], tools, onText: (d) => (streamed += d) });
    console.log(model, `${Date.now() - t0}ms`, "calls:", JSON.stringify(r.toolCalls), "text:", JSON.stringify(r.content.slice(0, 80)), "usage:", JSON.stringify(r.usage));
  } catch (e) {
    console.log(model, "ERROR", String(e.message).slice(0, 200));
  }
}
