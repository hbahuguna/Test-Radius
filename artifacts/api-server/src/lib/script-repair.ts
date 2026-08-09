import OpenAI from "openai";
import type { GeneratedTraceStep } from "./playwright-script";

export async function repairPlaywrightScript(input: {
  code: string;
  error: string;
  trace: GeneratedTraceStep[];
  provider: string;
  apiKey: string;
}): Promise<{ code: string; explanation: string; warnings: string[] }> {
  const isOpenCode = input.provider === "opencode";
  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: isOpenCode ? (process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1") : undefined,
  });
  const response = await client.chat.completions.create({
    model: isOpenCode ? "big-pickle" : process.env.CODE_REPAIR_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "Repair a Playwright TypeScript script. Return JSON only with keys code, explanation, warnings. Preserve the export default run({ page, step }) contract. Never add imports except `import type` from playwright. Do not add secrets or arbitrary filesystem/process access.",
      },
      {
        role: "user",
        content: JSON.stringify({
          error: input.error.slice(0, 4000),
          code: input.code.slice(0, 250_000),
          trace: input.trace.slice(0, 100),
        }),
      },
    ],
    temperature: 0,
  });
  const content = response.choices[0]?.message?.content || "";
  const jsonText = content.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || content;
  const parsed = JSON.parse(jsonText) as { code?: string; explanation?: string; warnings?: string[] };
  if (!parsed.code || !parsed.code.includes("export default")) throw new Error("Repair response did not contain a valid script");
  return {
    code: parsed.code,
    explanation: parsed.explanation || "Repaired from the execution failure.",
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}
