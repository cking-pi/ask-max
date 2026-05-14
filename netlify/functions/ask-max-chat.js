const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const KNOWN_MACHINES = [
  "SABERjet XL",
  "SABERjet XP",
  "SABERjet",
  "JAVELIN",
  "TITAN 4800",
  "TITAN 4700",
  "TITAN 3700",
  "TITAN 3000",
  "TITAN",
  "VOYAGER XP",
  "VOYAGER",
  "FASTBACK",
  "SPARTAN",
  "YUKON",
  "FUSION",
  "HYDRASPLIT",
  "THINSTONE",
  "TXS",
  "Pathfinder",
  "CrossCut XP",
  "CrossCut",
  "SlabVision",
  "Load N Go",
  "Load N' Go"
];

exports.handler = async function (event) {
  const corsHeaders = getCorsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
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

    const name = cleanText(body.name);
    const company = cleanText(body.company);
    const existingMachine = cleanText(body.machine);

    if (!userMessage) {
      return jsonResponse(400, { error: "Message is required" }, corsHeaders);
    }

    const detectedMachines = extractMachines(userMessage);
    const machine = mergeMachines(existingMachine, detectedMachines);

    const assistantResult = await getAssistantReply({
      userMessage,
      threadId: threadIdFromRequest
    });

    await logToGoogleSheet({
      sessionId,
      startedAt,
      lastUpdatedAt,
      name,
      company,
      machine
    });

    return jsonResponse(
      200,
      {
        sessionId,
        threadId: assistantResult.threadId,
        startedAt,
        lastUpdatedAt,
        reply: assistantResult.reply,
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
  return { statusCode, headers, body: JSON.stringify(body) };
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

function mergeMachines(existingMachineText, newMachines) {
  const machines = new Set();

  if (existingMachineText) {
    existingMachineText
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => machines.add(item));
  }

  newMachines
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => machines.add(item));

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

async function logToGoogleSheet({
  sessionId,
  startedAt,
  lastUpdatedAt,
  name,
  company,
  machine
}) {
  const response = await fetch(process.env.GOOGLE_SCRIPT_WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: process.env.GOOGLE_SCRIPT_SECRET,
      sessionId,
      startedAt,
      lastUpdatedAt,
      name,
      company,
      machine
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
