const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const KNOWN_MACHINES = [
  "SABERjet XP",
  "SABERjet",
  "SABER",
  "JAVELIN",
  "VOYAGER XP",
  "TITAN 4000 Series",
  "TITAN 3000 Series",
  "TITAN 2000 Series",
  "TITAN 1000 Series",
  "TITAN Fab Center",
  "SPARTAN",
  "FASTBACK II",
  "FASTBACK",
  "Pro-Edge IV",
  "DESTINY XE",
  "DESTINY",
  "HydroClear PRO",
  "HydroClear",
  "Side-Shot",
  "SIERRA",
  "YUKON II",
  "YUKON",
  "FUSION",
  "HYDRASPLIT",
  "THINSTONE TXS-3000",
  "THINSTONE TXS-4000",
  "Pathfinder",
  "CrossCut XP",
  "CrossCut",
  "SlabVision",
  "VELOCITY"
];

exports.handler = async function (event) {
  const corsHeaders = getCorsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" }, corsHeaders);
  }

  try {
    validateEnvironment();

    const body = JSON.parse(event.body || "{}");

    const userMessage = cleanText(body.message);
    const sessionId = cleanText(body.sessionId) || createSessionId();
    const threadIdFromRequest = cleanText(body.threadId);
    const startedAt = cleanText(body.startedAt) || new Date().toISOString();
    const lastUpdatedAt = new Date().toISOString();

    if (!userMessage) {
      return jsonResponse(400, { error: "Message is required" }, corsHeaders);
    }

    const extracted = await extractSessionDetails(userMessage);
    const machine = extractMachines(userMessage, extracted.machine);

    const assistantResult = await getAssistantReply({
      userMessage,
      threadId: threadIdFromRequest
    });

    await logToGoogleSheet({
      sessionId,
      startedAt,
      lastUpdatedAt,
      name: extracted.name,
      company: extracted.company,
      machine,
      userInput: userMessage,
      askMaxOutput: assistantResult.reply
    });

    return jsonResponse(
      200,
      {
        sessionId,
        threadId: assistantResult.threadId,
        startedAt,
        lastUpdatedAt,
        reply: assistantResult.reply,
        name: extracted.name,
        company: extracted.company,
        machine
      },
      corsHeaders
    );
  } catch (error) {
    console.error("Ask Max error:", error);

    return jsonResponse(
      500,
      {
        error: "Unable to process Ask Max request",
        details: error.message
      },
      corsHeaders
    );
  }
};

function getCorsHeaders(event) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  const requestOrigin = event.headers.origin || event.headers.Origin || "";

  const origin =
    allowedOrigin === "*" || allowedOrigin === requestOrigin
      ? allowedOrigin === "*"
        ? "*"
        : requestOrigin
      : allowedOrigin;

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };
}

function jsonResponse(statusCode, body, headers) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

function validateEnvironment() {
  const required = [
    "OPENAI_API_KEY",
    "OPENAI_ASSISTANT_ID",
    "GOOGLE_SCRIPT_WEB_APP_URL",
    "GOOGLE_SCRIPT_SECRET"
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function createSessionId() {
  return `askmax_${Date.now()}_${crypto.randomUUID()}`;
}

function extractMachines(userMessage, extractedMachineText = "") {
  const combinedText = `${userMessage} ${extractedMachineText}`.toLowerCase();
  const machines = new Set();

  const has = (pattern) => pattern.test(combinedText);

  // TITAN series handling.
  // This prevents plain "TITAN" from being logged as a machine by itself.
  if (has(/\btitan\s*4(?:000)?\b/i) || has(/\btitan\s*4000\s*series\b/i)) {
    machines.add("TITAN 4000 Series");
  }

  if (has(/\btitan\s*3(?:000)?\b/i) || has(/\btitan\s*3000\s*series\b/i)) {
    machines.add("TITAN 3000 Series");
  }

  if (has(/\btitan\s*2(?:000)?\b/i) || has(/\btitan\s*2000\s*series\b/i)) {
    machines.add("TITAN 2000 Series");
  }

  if (has(/\btitan\s*1(?:000)?\b/i) || has(/\btitan\s*1000\s*series\b/i)) {
    machines.add("TITAN 1000 Series");
  }

  if (has(/\btitan\s*fab\s*center\b/i)) {
    machines.add("TITAN Fab Center");
  }

  // Voyager should normalize to VOYAGER XP.
  if (has(/\bvoyager(?:\s*xp)?\b/i)) {
    machines.add("VOYAGER XP");
  }

  // Prefer more specific versions first.
  const machinePatterns = [
    ["SABERjet XP", /\bsaber\s*jet\s*xp\b|\bsaberjet\s*xp\b/i],
    ["SABERjet", /\bsaber\s*jet\b|\bsaberjet\b/i],
    ["SABER", /\bsaber\b/i],
    ["JAVELIN", /\bjavelin\b/i],
    ["SPARTAN", /\bspartan\b/i],
    ["FASTBACK II", /\bfastback\s*ii\b|\bfastback\s*2\b/i],
    ["FASTBACK", /\bfastback\b/i],
    ["Pro-Edge IV", /\bpro[-\s]*edge\s*iv\b|\bpro[-\s]*edge\s*4\b/i],
    ["DESTINY XE", /\bdestiny\s*xe\b/i],
    ["DESTINY", /\bdestiny\b/i],
    ["HydroClear PRO", /\bhydro\s*clear\s*pro\b|\bhydroclear\s*pro\b/i],
    ["HydroClear", /\bhydro\s*clear\b|\bhydroclear\b/i],
    ["Side-Shot", /\bside[-\s]*shot\b/i],
    ["SIERRA", /\bsierra\b/i],
    ["YUKON II", /\byukon\s*ii\b|\byukon\s*2\b/i],
    ["YUKON", /\byukon\b/i],
    ["FUSION", /\bfusion\b/i],
    ["HYDRASPLIT", /\bhydra\s*split\b|\bhydrasplit\b/i],
    ["THINSTONE TXS-3000", /\bthinstone\s*txs[-\s]*3000\b|\btxs[-\s]*3000\b/i],
    ["THINSTONE TXS-4000", /\bthinstone\s*txs[-\s]*4000\b|\btxs[-\s]*4000\b/i],
    ["Pathfinder", /\bpathfinder\b/i],
    ["CrossCut XP", /\bcross\s*cut\s*xp\b|\bcrosscut\s*xp\b/i],
    ["CrossCut", /\bcross\s*cut\b|\bcrosscut\b/i],
    ["SlabVision", /\bslab\s*vision\b|\bslabvision\b/i],
    ["VELOCITY", /\bvelocity\b/i]
  ];

  for (const [machineName, pattern] of machinePatterns) {
    if (has(pattern)) {
      machines.add(machineName);
    }
  }

  // Remove less specific duplicates when a more specific version exists.
  if (machines.has("FASTBACK II")) machines.delete("FASTBACK");
  if (machines.has("DESTINY XE")) machines.delete("DESTINY");
  if (machines.has("HydroClear PRO")) machines.delete("HydroClear");
  if (machines.has("YUKON II")) machines.delete("YUKON");
  if (machines.has("CrossCut XP")) machines.delete("CrossCut");

  return Array.from(machines).join("; ");
}

async function getAssistantReply({ userMessage, threadId }) {
  let activeThreadId = threadId;

  if (!activeThreadId) {
    const thread = await openai.beta.threads.create();
    activeThreadId = thread.id;
  }

  await openai.beta.threads.messages.create(activeThreadId, {
    role: "user",
    content: userMessage
  });

  const run = await openai.beta.threads.runs.createAndPoll(activeThreadId, {
    assistant_id: process.env.OPENAI_ASSISTANT_ID
  });

  if (run.status !== "completed") {
    throw new Error(`Assistant run did not complete. Status: ${run.status}`);
  }

  const messages = await openai.beta.threads.messages.list(activeThreadId, {
    limit: 10
  });

  const latestAssistantMessage = messages.data.find(
    (message) => message.role === "assistant"
  );

  if (!latestAssistantMessage) {
    return {
      threadId: activeThreadId,
      reply: "Sorry, I was not able to generate a response."
    };
  }

  const reply = latestAssistantMessage.content
    .map((contentItem) => {
      if (contentItem.type === "text") {
        return contentItem.text.value;
      }

      return "";
    })
    .join("\n")
    .trim();

  return {
    threadId: activeThreadId,
    reply: reply || "Sorry, I was not able to generate a response."
  };
}

async function extractSessionDetails(userMessage) {
  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_EXTRACT_MODEL,
      input: [
        {
          role: "system",
          content: `
Extract session details from the user's message.

Return only valid JSON:
{
  "name": "",
  "company": "",
  "machine": ""
}

Rules:
- Only fill fields that are clearly stated by the user.
- Do not guess.
- If the user gives "jon with abc com on a titan 3700", infer:
  name = "Jon"
  company = "ABC Com"
  machine = "TITAN 3000 Series"
- If the user says "my name is Sarah from Stone Pros and I have a FASTBACK", infer:
  name = "Sarah"
  company = "Stone Pros"
  machine = "FASTBACK"
- If the user only asks a technical question and does not provide name or company, leave those blank.
- If a field is not provided, return an empty string.
          `.trim()
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    const text = response.output_text || "{}";
    const parsed = JSON.parse(text);

    return {
      name: cleanText(parsed.name),
      company: cleanText(parsed.company),
      machine: cleanText(parsed.machine)
    };
  } catch (error) {
    console.error("Extraction error:", error);

    return {
      name: "",
      company: "",
      machine: ""
    };
  }
}

async function logToGoogleSheet({
  sessionId,
  startedAt,
  lastUpdatedAt,
  name,
  company,
  machine,
  userInput,
  askMaxOutput
}) {
  const response = await fetch(process.env.GOOGLE_SCRIPT_WEB_APP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: process.env.GOOGLE_SCRIPT_SECRET,
      sessionId,
      startedAt,
      lastUpdatedAt,
      name,
      company,
      machine,
      userInput,
      askMaxOutput
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Google Script request failed: ${text}`);
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Google Script returned non-JSON response: ${text}`);
  }

  if (!data.success) {
    throw new Error(`Google Script error: ${data.error || "Unknown error"}`);
  }

  return data;
}
