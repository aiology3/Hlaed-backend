const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

// Gemini model to use
const GEMINI_MODEL = "gemini-flash-latest";

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

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Hlaed backend running ✅ (powered by Gemini)" });
});

// Chat endpoint — API key stays here, never exposed to browser
app.post("/api/chat", async (req, res) => {
  const { messages, systemPrompt } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Invalid messages format" });
  }

  const system = systemPrompt || defaultSystemPrompt;

  try {
    // Convert messages from {role, content} format to Gemini format
    // Gemini uses "user" and "model" roles (not "assistant")
    const geminiContents = messages.map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    const geminiBody = {
      system_instruction: {
        parts: [{ text: system }],
      },
      contents: geminiContents,
      generationConfig: {
        maxOutputTokens: 1000,
        temperature: 0.7,
      },
    };

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error:", data);
      return res.status(response.status).json({
        error: data.error?.message || "Gemini API error",
      });
    }

    // Extract text from Gemini response
    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";

    // Return in a format the frontend understands
    res.json({
      content: [{ type: "text", text }],
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Hlaed backend running on port ${PORT}`);
  console.log(`🤖 Using Gemini model: ${GEMINI_MODEL}`);
});
