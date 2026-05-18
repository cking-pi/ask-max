const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
    const startedAt = cleanText(body.startedAt) || new Date().toISOString();
    const lastUpdatedAt = new Date().toISOString();

    // These are used only for logging/session return, not sent to OpenAI.
    const existingName = cleanText(body.name);
    const existingCompany = cleanText(body.company);
    const existingMachine = cleanText(body.machine);

    if (!userMessage) {
      return jsonResponse(400, { error: "Message is required" }, corsHeaders);
    }

    const extracted = extractBasicSessionDetails({
      userMessage,
      existingName,
      existingCompany,
      existingMachine
    });

    const finalName = existingName || extracted.name;
    const finalCompany = existingCompany || extracted.company;
    const finalMachine = mergeMachineText(existingMachine, extracted.machine);

    const assistantResult = await getAssistantReply({
      userMessage
    });

    const googleLog = await logToGoogleSheetWithTimeout({
      sessionId,
      startedAt,
      lastUpdatedAt,
      name: finalName,
      company: finalCompany,
      machine: finalMachine,
      userInput: userMessage,
      askMaxOutput: assistantResult.reply
    });

    return jsonResponse(
      200,
      {
        sessionId,
        startedAt,
        lastUpdatedAt,
        reply: assistantResult.reply,
        name: finalName,
        company: finalCompany,
        machine: finalMachine,
        googleLog
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

function titleCase(value) {
  return String(value || "")
    .split(" ")
    .map((word) => {
      if (!word) return "";
      if (word.toUpperCase() === word && word.length <= 4) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ")
    .trim();
}

/**
 * Light intake capture only.
 * This is only used for Google Sheets/session return.
 * It is NOT sent to the Assistant.
 */
function extractBasicSessionDetails({
  userMessage,
  existingName,
  existingCompany,
  existingMachine
}) {
  const message = cleanText(userMessage);

  let name = "";
  let company = "";
  let machine = "";

  if (!existingName || !existingCompany) {
    const nameCompany = extractNameCompany(message);

    if (!existingName) {
      name = nameCompany.name;
    }

    if (!existingCompany) {
      company = nameCompany.company;
    }
  }

  if (!existingMachine) {
    machine = extractMachineMention(message);
  }

  return {
    name,
    company,
    machine
  };
}

function extractNameCompany(message) {
  let name = "";
  let company = "";

  let match;

  match = message.match(/^my name is\s+(.+?)\s+(?:from|with|at|of)\s+(.+)$/i);
  if (match) {
    return {
      name: cleanLikelyName(match[1]),
      company: cleanLikelyCompany(match[2])
    };
  }

  match = message.match(/^i'?m\s+(.+?)\s+(?:from|with|at|of)\s+(.+)$/i);
  if (match) {
    return {
      name: cleanLikelyName(match[1]),
      company: cleanLikelyCompany(match[2])
    };
  }

  match = message.match(/^(.+?)\s+(?:from|with|at|of)\s+(.+)$/i);
  if (match) {
    return {
      name: cleanLikelyName(match[1]),
      company: cleanLikelyCompany(match[2])
    };
  }

  const machine = extractMachineMention(message);
  const words = message.split(/\s+/).filter(Boolean);

  // First prompt is name/company, so simple replies like "jon abc company"
  // should be treated as name + company when no machine is detected.
  if (words.length >= 2 && words.length <= 6 && !machine) {
    name = cleanLikelyName(words[0]);
    company = cleanLikelyCompany(words.slice(1).join(" "));
  }

  return {
    name,
    company
  };
}

function cleanLikelyName(value) {
  let cleaned = cleanText(value)
    .replace(/^my name is\s+/i, "")
    .replace(/^i'?m\s+/i, "")
    .replace(/[.,]+$/g, "")
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);

  if (!words.length || words.length > 3) return "";

  return titleCase(words.join(" "));
}

function cleanLikelyCompany(value) {
  let cleaned = cleanText(value)
    .replace(/\b(?:and|i|we)\s+(?:have|need|am|are|use|using).*$/i, "")
    .replace(/[.,]+$/g, "")
    .trim();

  if (!cleaned) return "";

  return titleCase(cleaned);
}

/**
 * Light machine capture only for Google Sheets.
 * Do not over-normalize or force series conversions here.
 * The Assistant receives only the user's raw message and interprets context itself.
 */
function extractMachineMention(message) {
  const text = cleanText(message);
  const lower = text.toLowerCase();

  const patterns = [
    ["SABERjet XP", /\bsaber\s*jet\s*xp\b|\bsaberjet\s*xp\b/i],
    ["SABERjet", /\bsaber\s*jet\b|\bsaberjet\b/i],
    ["SABER", /\bsaber\b/i],
    ["JAVELIN", /\bjavelin\b/i],
    ["VOYAGER XP", /\bvoyager(?:\s*xp)?\b/i],

    ["TITAN Fab Center", /\btitan\s*fab\s*center\b/i],
    ["TITAN 1000 Series", /\btitan\s*1000\s*series\b/i],
    ["TITAN 2000 Series", /\btitan\s*2000\s*series\b/i],
    ["TITAN 3000 Series", /\btitan\s*3000\s*series\b/i],
    ["TITAN 4000 Series", /\btitan\s*4000\s*series\b/i],

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

  const found = new Set();

  for (const [name, pattern] of patterns) {
    if (pattern.test(lower)) {
      found.add(name);
    }
  }

  // Capture specific TITAN model numbers without guessing the series.
  const titanModel = text.match(/\btitan\s*(\d{3,4})\b/i);
  if (titanModel) {
    found.add(`TITAN ${titanModel[1]}`);
  }

  // If user only says "TITAN", store TITAN instead of forcing a series.
  if (/\btitan\b/i.test(text) && !Array.from(found).some((item) => item.startsWith("TITAN"))) {
    found.add("TITAN");
  }

  // Remove less specific duplicates.
  if (found.has("FASTBACK II")) found.delete("FASTBACK");
  if (found.has("DESTINY XE")) found.delete("DESTINY");
  if (found.has("HydroClear PRO")) found.delete("HydroClear");
  if (found.has("YUKON II")) found.delete("YUKON");
  if (found.has("CrossCut XP")) found.delete("CrossCut");

  return Array.from(found).join("; ");
}

function mergeMachineText(existingMachineText, newMachineText) {
  const machines = new Set();

  String(existingMachineText || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => machines.add(item));

  String(newMachineText || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => machines.add(item));

  return Array.from(machines).join("; ");
}

/**
 * Pure Assistant call.
 * No Netlify-added context is sent to OpenAI.
 * The Assistant only receives the user's raw message.
 */
async function getAssistantReply({ userMessage }) {
  const thread = await openai.beta.threads.create();
  const activeThreadId = thread.id;

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

async function logToGoogleSheetWithTimeout({
  sessionId,
  startedAt,
  lastUpdatedAt,
  name,
  company,
  machine,
  userInput,
  askMaxOutput
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(process.env.GOOGLE_SCRIPT_WEB_APP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      signal: controller.signal,
      body: JSON.stringify({
        secret: process.env.GOOGLE_SCRIPT_SECRET,
        sessionId,
        startedAt,
        lastUpdatedAt,
        name,
        company,
        machine,
        userInput,
        askMaxOutput,
        message: userInput,
        reply: askMaxOutput
      })
    });

    const text = await response.text();

    if (!response.ok) {
      return {
        success: false,
        action: "google_script_failed",
        status: response.status,
        responsePreview: text.slice(0, 300)
      };
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      return {
        success: true,
        action: "logged_non_json_response"
      };
    }
  } catch (error) {
    return {
      success: false,
      action: error.name === "AbortError" ? "google_script_timeout" : "google_script_error",
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}
