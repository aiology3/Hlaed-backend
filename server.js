const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

// ─── Model fallback list ───────────────────────────────────────────────────────
// If first model is busy/fails, automatically tries the next one
const GEMINI_MODELS = [
  "gemini-flash-latest",     // Primary — fastest
  "gemini-1.5-flash-latest", // Fallback 1
  "gemini-1.5-flash",        // Fallback 2
  "gemini-1.0-pro",          // Fallback 3 — most stable
];

const MAX_RETRIES = 3;       // Retry each model up to 3 times
const RETRY_DELAY_MS = 1500; // Wait 1.5s between retries

// ─── System prompt ─────────────────────────────────────────────────────────────
const defaultSystemPrompt = `You are Hlaed, an advanced multi-step reasoning and planning agent built by Hlaed.

Your identity:
- Your name is Hlaed. That is your only name.
- You were created by Hlaed, an Indian company pioneering the future of AI, cybersecurity, and cutting-edge IT solutions.
- You are not built on any other AI, and you do not reference any other AI system, company, or technology behind you.
- If anyone asks who made you, what you are built on, or what technology powers you, simply say: "I am Hlaed, an AI agent proudly built by Hlaed — an Indian company pioneering the future of AI, cybersecurity, and cutting-edge IT solutions."
- Never mention Claude, Anthropic, GPT, OpenAI, Gemini, Google, or any other AI company or model — not even to deny using them. Never confuse yourself (the AI agent) with Hlaed the company — both share the name but you are the agent, and Hlaed is also the company that built you.

When given a task or problem:
1. Break it down into clear, logical steps
2. Reason through each step carefully
3. Ask clarifying questions when needed
4. Maintain context from earlier in the conversation
5. Provide structured, actionable outputs

Always think before you act. For complex tasks, show your reasoning process explicitly using "Step 1:", "Step 2:", etc. Be concise, sharp, and insightful.`;

// ─── Helper: sleep ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Helper: call Gemini with one specific model ───────────────────────────────
async function callGemini(model, geminiContents, system) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const geminiBody = {
    system_instruction: { parts: [{ text: system }] },
    contents: geminiContents,
    generationConfig: {
      maxOutputTokens: 1000,
      temperature: 0.7,
    },
  };

  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody),
  });

  const data = await response.json();
  return { response, data };
}

// ─── Helper: is error retryable? ──────────────────────────────────────────────
function isRetryable(status, data) {
  // 429 = rate limit / quota exceeded / high demand
  // 503 = service unavailable
  // 500 = internal server error (sometimes temporary)
  const retryableCodes = [429, 503, 500];
  if (retryableCodes.includes(status)) return true;

  const msg = data?.error?.message || "";
  if (msg.includes("high demand")) return true;
  if (msg.includes("quota")) return true;
  if (msg.includes("rate limit")) return true;
  if (msg.includes("Resource exhausted")) return true;
  return false;
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "Hlaed backend running ✅",
    models: GEMINI_MODELS,
    retries: MAX_RETRIES,
  });
});

// ─── Chat endpoint ─────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { messages, systemPrompt } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Invalid messages format" });
  }

  const system = systemPrompt || defaultSystemPrompt;

  // Convert to Gemini format (uses "model" instead of "assistant")
  const geminiContents = messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  let lastError = null;

  // ── Try each model in the fallback list ──────────────────────────────────────
  for (const model of GEMINI_MODELS) {
    // ── Retry the same model up to MAX_RETRIES times ────────────────────────
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`🔄 Trying model: ${model} | Attempt: ${attempt}/${MAX_RETRIES}`);

        const { response, data } = await callGemini(model, geminiContents, system);

        // ✅ Success
        if (response.ok) {
          const text =
            data.candidates?.[0]?.content?.parts?.[0]?.text ||
            "No response generated.";

          console.log(`✅ Success with model: ${model} on attempt ${attempt}`);
          return res.json({ content: [{ type: "text", text }] });
        }

        // ❌ Non-retryable error (e.g. bad request, invalid key)
        if (!isRetryable(response.status, data)) {
          console.error(`❌ Non-retryable error on model ${model}:`, data?.error?.message);
          lastError = data?.error?.message || "API error";
          break; // Skip retries, try next model
        }

        // ⏳ Retryable error — wait and retry
        console.warn(`⚠️ Model ${model} busy (attempt ${attempt}). Retrying in ${RETRY_DELAY_MS}ms...`);
        lastError = data?.error?.message || "High demand error";

        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt); // Progressive delay: 1.5s, 3s, 4.5s
        }

      } catch (err) {
        // Network error — retry
        console.error(`🔥 Network error on model ${model} attempt ${attempt}:`, err.message);
        lastError = "Network error";
        if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
      }
    }

    console.warn(`⏭️ All retries exhausted for model: ${model}. Trying next fallback...`);
  }

  // All models and retries failed
  console.error("💀 All models and retries failed. Last error:", lastError);
  return res.status(503).json({
    error: "Hlaed is experiencing very high demand right now. Please try again in a moment.",
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Hlaed backend running on port ${PORT}`);
  console.log(`🤖 Primary model: ${GEMINI_MODELS[0]}`);
  console.log(`🔁 Fallback models: ${GEMINI_MODELS.slice(1).join(", ")}`);
  console.log(`🔄 Max retries per model: ${MAX_RETRIES}`);
});
