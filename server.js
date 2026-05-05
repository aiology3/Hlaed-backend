const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : ["http://localhost:3000"];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) cb(null, true);
    else cb(new Error("Not allowed by CORS"));
  },
  methods: ["POST", "GET"],
  allowedHeaders: ["Content-Type"],
}));

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'none'; object-src 'none'");
  next();
});

// ─── Rate limiting — prevent abuse ────────────────────────────────────────────
const rateLimitMap = new Map();
app.use("/api/", (req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 30; // max 30 requests per minute per IP

  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);

  if (timestamps.length > maxRequests) {
    return res.status(429).json({ error: "Too many requests. Please slow down." });
  }
  next();
});

// ─── Input validation ─────────────────────────────────────────────────────────
function sanitizeMessages(messages) {
  return messages
    .filter(m => m && typeof m.role === "string" && typeof m.content === "string")
    .map(m => ({
      role: ["user","assistant"].includes(m.role) ? m.role : "user",
      content: m.content.slice(0, 8000), // max 8000 chars per message
    }))
    .slice(-20); // keep last 20 messages only
}

app.use(express.json({ limit: "1mb" }));

// ─── Gemini model fallback list ────────────────────────────────────────────────
const GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash",
  "gemini-1.0-pro",
];
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

// ─── System prompt ─────────────────────────────────────────────────────────────
const defaultSystemPrompt = `You are Hlaed, a professional AI research and reasoning agent built by Hlaed — an Indian company pioneering the future of AI, cybersecurity, and cutting-edge IT solutions.

IDENTITY:
- Your name is Hlaed. That is your only name.
- You were created by Hlaed company.
- Never mention Claude, Anthropic, GPT, OpenAI, Gemini, Google, Tavily, or any other AI/search company or model.
- If asked who made you: "I am Hlaed, an AI agent proudly built by Hlaed — an Indian company pioneering the future of AI, cybersecurity, and cutting-edge IT solutions."

YOUR USERS:
- Researchers, business professionals, entrepreneurs, scientists, and experts.
- They expect professional, accurate, well-structured, and cited answers.
- Never give vague or generic answers — always be specific, data-driven, and factual.

RESPONSE STYLE — adapt based on how user asks:
- If user asks casually → give a clear, direct best answer with sources at the bottom
- If user asks for a summary → summarize key findings, then list sources
- If user asks for research/deep analysis → give detailed structured answer with inline citations [1][2] and full source list
- If user asks for latest news → present as news briefing with headlines and sources
- If user asks for comparison → use structured comparison with data points and sources
- Always end professional research answers with a "Sources:" section

WEB SEARCH DATA:
- When web search results are provided to you, use them as your PRIMARY source of truth.
- Always cite sources. Format: [1] Source Title — URL
- Clearly distinguish between what you found from search vs your own knowledge.
- If search results are provided, prioritize them over your training data for current facts.
- Never fabricate URLs or sources. Only cite what was actually found in search results.

FLOWCHART CAPABILITY:
- When asked for flowchart, diagram, workflow, or process map, generate Mermaid.js:
\`\`\`mermaid
flowchart TD
    A[Start] --> B[Step 1]
    B --> C{Decision}
    C -->|Yes| D[Result 1]
    C -->|No| E[Result 2]
\`\`\`
- Use TD for top-down, LR for left-right.
- After the diagram, briefly explain the flow.

IMAGE GENERATION:
- Image generation is handled automatically by the system when users request it.
- If a user asks for an image and you see "I am generating your image now..." in context, simply confirm the image is being created.
- Do NOT describe images or give visual descriptions when a user asks to generate an image — the system handles this automatically.
- Never mention Pollinations, Stability AI, or any image service name.

REASONING:
- Break complex problems into clear steps.
- For multi-step tasks use "Step 1:", "Step 2:", etc.
- Be concise, sharp, professional, and insightful.`;

// ─── Search trigger keywords ───────────────────────────────────────────────────
const SEARCH_TRIGGER_KEYWORDS = [
  "latest","recent","current","today","now","2024","2025","2026","news","update","trend",
  "research","study","report","statistics","data","survey","analysis","findings","evidence",
  "market","price","stock","revenue","funding","startup","company","industry","competitor",
  "investment","ipo","valuation","growth rate","market share","gdp","inflation",
  "discovered","breakthrough","launched","released","announced","new version","patent",
  "who is","what is the","how many","when did","where is","which country","best in",
  "top 10","list of","examples of","case study","compare","vs","versus",
  "regulation","law","policy","government","tax","compliance","standard","certification",
];

// ─── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function needsWebSearch(messages) {
  const last = [...messages].reverse().find(m => m.role === "user");
  if (!last) return false;
  const text = last.content.toLowerCase();
  if (["search","look up","find me","what's happening","browse"].some(k => text.includes(k))) return true;
  return SEARCH_TRIGGER_KEYWORDS.some(kw => text.includes(kw));
}

function extractSearchQuery(messages) {
  const last = [...messages].reverse().find(m => m.role === "user");
  return last ? last.content : "";
}

// ─── Image generation helpers ──────────────────────────────────────────────────
const IMAGE_TRIGGER_WORDS = [
  "generate an image","generate image","create an image","create image",
  "make an image","make image","draw me","draw a","draw an",
  "illustrate","create a picture","generate a picture","show me a picture",
  "create a photo","generate a photo","make a logo","create a logo",
  "design a logo","generate art","make art","create art","create artwork",
  "generate artwork","paint a","paint me","sketch a","sketch me",
  "create a visual","generate a visual","show an image","show a picture",
];

function isImageRequest(messages) {
  const last = [...messages].reverse().find(m => m.role === "user");
  if (!last) return false;
  const text = last.content.toLowerCase().trim();
  return IMAGE_TRIGGER_WORDS.some(kw => text.includes(kw));
}

// Build a clean image prompt directly from user message
function buildImagePromptFromMessage(messages) {
  const last = [...messages].reverse().find(m => m.role === "user");
  if (!last) return "";
  let text = last.content.trim();
  // Remove common prefix phrases to get the core subject
  const prefixes = [
    "generate an image of","generate image of","create an image of","create image of",
    "make an image of","make image of","draw me a","draw me an","draw a","draw an",
    "create a picture of","generate a picture of","show me a picture of",
    "create a photo of","generate a photo of","make a logo for","create a logo for",
    "design a logo for","generate art of","make art of","create art of",
    "paint a","paint me a","sketch a","sketch me a","illustrate",
    "generate","create","make","draw","show",
  ];
  const lower = text.toLowerCase();
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  // Enhance prompt for better image quality
  return text + ", high quality, detailed, professional, 8k resolution";
}

function buildPollinationsUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  const seed = Math.floor(Math.random() * 999999);
  return `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&seed=${seed}&model=flux&nologo=true&enhance=true`;
}

function isRetryable(status, data) {
  if ([429, 503, 500].includes(status)) return true;
  const msg = data?.error?.message || "";
  return msg.includes("high demand") || msg.includes("quota") ||
         msg.includes("rate limit") || msg.includes("Resource exhausted");
}

// ─── Tavily search ─────────────────────────────────────────────────────────────
async function tavilySearch(query) {
  console.log(`🔍 Searching: "${query}"`);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "advanced",
      include_answer: true,
      include_raw_content: false,
      max_results: 6,
    }),
  });
  if (!res.ok) throw new Error(`Tavily failed: ${await res.text()}`);
  return res.json();
}

function formatSearchResults(searchData, query) {
  let ctx = `WEB SEARCH RESULTS FOR: "${query}"\nSearch time: ${new Date().toUTCString()}\n\n`;
  if (searchData.answer) ctx += `QUICK ANSWER: ${searchData.answer}\n\n`;
  ctx += `TOP SOURCES:\n`;
  searchData.results.forEach((r, i) => {
    ctx += `\n[${i+1}] ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n`;
  });
  ctx += `\nINSTRUCTION: Use above as PRIMARY source. Cite with [1][2] etc. End with "Sources:" section.`;
  return ctx;
}

// ─── Gemini streaming call ─────────────────────────────────────────────────────
async function callGeminiStream(model, geminiContents, system, res) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${process.env.GEMINI_API_KEY}&alt=sse`;

  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: geminiContents,
    generationConfig: { maxOutputTokens: 2000, temperature: 0.3 },
  };

  const geminiRes = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!geminiRes.ok) {
    const errData = await geminiRes.json();
    return { success: false, status: geminiRes.status, data: errData };
  }

  // Stream SSE chunks to client
  return new Promise((resolve) => {
    let buffer = "";
    let fullText = "";

    geminiRes.body.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (text) {
              fullText += text;
              // Send chunk to client as SSE
              res.write(`data: ${JSON.stringify({ type: "chunk", text })}\n\n`);
            }
          } catch (_) {}
        }
      }
    });

    geminiRes.body.on("end", () => {
      resolve({ success: true, fullText });
    });

    geminiRes.body.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

// ─── Gemini non-streaming fallback ────────────────────────────────────────────
async function callGeminiFallback(model, geminiContents, system) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    system_instruction: { parts: [{ text: system }] },
    contents: geminiContents,
    generationConfig: { maxOutputTokens: 2000, temperature: 0.3 },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "Hlaed backend running ✅",
    features: ["streaming", "tavily-search", "image-generation", "auto-detect", "retry-fallback"],
    models: GEMINI_MODELS,
  });
});

// ─── Image generation endpoint ─────────────────────────────────────────────────
app.post("/api/generate-image", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Prompt required" });

  try {
    console.log(`🎨 Generating image: "${prompt.slice(0,60)}..."`);
    const imageUrl = buildPollinationsUrl(prompt);

    // Verify image is accessible
    const check = await fetch(imageUrl, { method: "HEAD" });
    if (!check.ok) throw new Error("Image generation failed");

    console.log("✅ Image generated successfully");
    res.json({ imageUrl, prompt });
  } catch (err) {
    console.error("❌ Image generation error:", err.message);
    res.status(500).json({ error: "Image generation failed. Please try again." });
  }
});

// ─── Streaming chat endpoint ───────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  let { messages, systemPrompt } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Invalid messages format" });
  }
  const sanitized = sanitizeMessages(messages);
  if (!sanitized.length) return res.status(400).json({ error: "No valid messages" });
  messages = sanitized;

  const system = systemPrompt || defaultSystemPrompt;
  let searchPerformed = false;
  let searchQuery = "";

  // ── Setup SSE streaming headers ────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  try {
    let augmentedMessages = [...messages];

    // ── Direct image generation — detect before calling AI ─────────────────
    if (isImageRequest(messages)) {
      const imagePrompt = buildImagePromptFromMessage(messages);
      const imageUrl = buildPollinationsUrl(imagePrompt);
      console.log(`🎨 Image request detected: "${imagePrompt}"`);

      // Tell frontend image is generating
      res.write(`data: ${JSON.stringify({ type: "chunk", text: "I am generating your image now..." })}

`);
      await sleep(300);
      res.write(`data: ${JSON.stringify({ type: "chunk", text: "\n\nHere is your generated image:" })}

`);
      res.write(`data: ${JSON.stringify({ type: "generate_image", prompt: imagePrompt, imageUrl })}

`);
      res.write(`data: ${JSON.stringify({ type: "done", searchPerformed: false, searchQuery: null })}

`);
      return;
    }

    // ── Auto web search ────────────────────────────────────────────────────
    if (needsWebSearch(messages) && process.env.TAVILY_API_KEY) {
      try {
        searchQuery = extractSearchQuery(messages);
        // Tell frontend search is happening
        res.write(`data: ${JSON.stringify({ type: "searching", query: searchQuery })}\n\n`);

        const searchData = await tavilySearch(searchQuery);
        const searchContext = formatSearchResults(searchData, searchQuery);

        augmentedMessages = [
          ...messages.slice(0, -1),
          {
            role: "user",
            content: `${searchContext}\n\nUSER QUESTION: ${messages[messages.length-1].content}`,
          },
        ];
        searchPerformed = true;
        res.write(`data: ${JSON.stringify({ type: "search_done", count: searchData.results.length })}\n\n`);
        console.log(`✅ Search done — ${searchData.results.length} sources`);
      } catch (searchErr) {
        console.warn("⚠️ Search failed:", searchErr.message);
        res.write(`data: ${JSON.stringify({ type: "search_failed" })}\n\n`);
      }
    }

    // ── Build Gemini content ───────────────────────────────────────────────
    const geminiContents = augmentedMessages.map(msg => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    // ── Try streaming with each model ─────────────────────────────────────
    let success = false;
    let fullText = "";
    let lastError = null;

    for (const model of GEMINI_MODELS) {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          console.log(`🔄 Streaming: ${model} | Attempt ${attempt}`);
          const result = await callGeminiStream(model, geminiContents, system, res);

          if (result.success) {
            fullText = result.fullText;
            success = true;
            console.log(`✅ Stream success: ${model}`);
            break;
          }

          // Non-streaming fallback if streaming endpoint fails
          if (result.status && !isRetryable(result.status, result.data)) {
            // Try non-streaming fallback
            const { response, data } = await callGeminiFallback(model, geminiContents, system);
            if (response.ok) {
              fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
              // Simulate streaming by sending in chunks
              const words = fullText.split(" ");
              for (let i = 0; i < words.length; i += 3) {
                const chunk = words.slice(i, i+3).join(" ") + (i+3 < words.length ? " " : "");
                res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
                await sleep(30);
              }
              success = true;
              break;
            }
            lastError = data?.error?.message;
            break;
          }

          lastError = result.data?.error?.message || result.error || "Stream error";
          if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);

        } catch (err) {
          lastError = err.message;
          if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
        }
      }
      if (success) break;
    }

    if (!success) {
      res.write(`data: ${JSON.stringify({ type: "error", message: "Hlaed is experiencing high demand. Please try again." })}\n\n`);
    } else {
      // Check if response contains image generation tag
      const imagePrompt = extractImagePrompt(fullText);
      if (imagePrompt) {
        // Tell frontend to generate image
        res.write(`data: ${JSON.stringify({ type: "generate_image", prompt: imagePrompt })}\n\n`);
      }
      // Signal completion with metadata
      res.write(`data: ${JSON.stringify({ type: "done", searchPerformed, searchQuery: searchPerformed ? searchQuery : null })}\n\n`);
    }

  } catch (err) {
    console.error("💀 Fatal:", err.message);
    res.write(`data: ${JSON.stringify({ type: "error", message: "Server error. Please try again." })}\n\n`);
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Hlaed backend on port ${PORT}`);
  console.log(`🔍 Tavily: ${process.env.TAVILY_API_KEY ? "✅ Enabled" : "❌ No key"}`);
  console.log(`📡 Streaming: ✅ Enabled`);
  console.log(`🎨 Image Generation: ✅ Pollinations AI (Free)`);
});
