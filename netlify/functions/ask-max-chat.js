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
  "FASTBACK",
  "FASTBACK II",
  "Pro-Edge IV",
  "DESTINY",
  "DESTINY XE",
  "HydroClear",
  "HydroClear PRO",
  "Side-Shot",
  "SIERRA",
  "YUKON",
  "YUKON II",
  "FUSION",
  "HYDRASPLIT",
  "THINSTONE TXS-3000",
  "THINSTONE TXS-4000",
  "Pathfinder",
  "CrossCut XP",
  "CrossCut",
  "SlabVision",
  "VELOCITY",
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

    const detectedMachines = extractMachines(userMessage);
    const machine = mergeMachines(extracted.machine, detectedMachines);

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

function extractMachines(message) {
  const normalizedMessage = message.toLowerCase();

  return KNOWN_MACHINES.filter((machine) =>
    normalizedMessage.includes(machine.toLowerCase())
  );
}

function mergeMachines(existingMachineText, newMachinesOrText) {
  const machines = new Set();

  String(existingMachineText || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => machines.add(item));

  if (Array.isArray(newMachinesOrText)) {
    newMachinesOrText
      .map((item) => String(item).trim())
      .filter(Boolean)
      .forEach((item) => machines.add(item));
  } else {
    String(newMachinesOrText || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => machines.add(item));
  }

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
      model: process.env.OPENAI_EXTRACT_MODEL || "gpt-4.1-mini",
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
- If the user gives a phrase like "jon abc com titan 3700", infer:
  name = "Jon"
  company = "ABC Com"
  machine = "TITAN 3700"
- If the user gives "my name is Sarah from Stone Pros and I have a FASTBACK", infer:
  name = "Sarah"
  company = "Stone Pros"
  machine = "FASTBACK"
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
