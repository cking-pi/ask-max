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

    const existingName = cleanText(body.name);
    const existingCompany = cleanText(body.company);
    const existingMachine = cleanText(body.machine);

    if (!userMessage) {
      return jsonResponse(400, { error: "Message is required" }, corsHeaders);
    }

    const extracted = extractSessionDetailsLocal({
      userMessage,
      existingName,
      existingCompany,
      existingMachine
    });

    const finalName = extracted.name || existingName;
    const finalCompany = extracted.company || existingCompany;

    const newlyDetectedMachine = extractMachines(userMessage, extracted.machine);
    const finalMachine = mergeMachineText(existingMachine, newlyDetectedMachine);

    const assistantResult = await getAssistantReply({
      userMessage,
      sessionContext: {
        name: finalName,
        company: finalCompany,
        machine: finalMachine
      }
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
        threadId: assistantResult.threadId,
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

function extractSessionDetailsLocal({
  userMessage,
  existingName,
  existingCompany,
  existingMachine
}) {
  const message = cleanText(userMessage);
  const machine = extractMachines(message, "");

  let name = "";
  let company = "";

  if (!existingName || !existingCompany) {
    let match;

    match = message.match(/^(.+?)\s+(?:from|with|at|of)\s+(.+)$/i);
    if (match) {
      name = cleanLikelyName(match[1]);
      company = cleanLikelyCompany(match[2]);
    }

    if (!name && !company) {
      match = message.match(/^my name is\s+(.+?)\s+(?:from|with|at|of)\s+(.+)$/i);
      if (match) {
        name = cleanLikelyName(match[1]);
        company = cleanLikelyCompany(match[2]);
      }
    }

    if (!name && !company) {
      match = message.match(/^i'?m\s+(.+?)\s+(?:from|with|at|of)\s+(.+)$/i);
      if (match) {
        name = cleanLikelyName(match[1]);
        company = cleanLikelyCompany(match[2]);
      }
    }

    if (!name && !company) {
      const words = message.split(/\s+/).filter(Boolean);

      if (words.length >= 2 && words.length <= 6 && !machine) {
        name = cleanLikelyName(words[0]);
        company = cleanLikelyCompany(words.slice(1).join(" "));
      }

      if (words.length >= 3 && machine) {
        const machineWords = machine.toLowerCase().split(/\s+/);

        const nonMachineWords = words.filter((word) => {
          return !machineWords.some((machineWord) =>
            machineWord.replace(/[^a-z0-9]/g, "") ===
            word.toLowerCase().replace(/[^a-z0-9]/g, "")
          );
        });

        if (nonMachineWords.length >= 2) {
          name = cleanLikelyName(nonMachineWords[0]);
          company = cleanLikelyCompany(nonMachineWords.slice(1).join(" "));
        }
      }
    }
  }

  if (existingName) {
    name = "";
  }

  if (existingCompany) {
    company = "";
  }

  return {
    name,
    company,
    machine: existingMachine ? "" : machine
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
    .replace(/\b(?:javelin|voyager|saberjet|saber|titan|spartan|fastback|yukon|fusion|crosscut|slabvision|velocity).*$/i, "")
    .replace(/[.,]+$/g, "")
    .trim();

  if (!cleaned) return "";

  return titleCase(cleaned);
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

function extractMachines(userMessage, extractedMachineText = "") {
  const combinedText = `${userMessage} ${extractedMachineText}`.toLowerCase();
  const machines = new Set();

  const has = (pattern) => pattern.test(combinedText);

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

  if (has(/\bvoyager(?:\s*xp)?\b/i)) {
    machines.add("VOYAGER XP");
  }

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

  if (machines.has("FASTBACK II")) machines.delete("FASTBACK");
  if (machines.has("DESTINY XE")) machines.delete("DESTINY");
  if (machines.has("HydroClear PRO")) machines.delete("HydroClear");
  if (machines.has("YUKON II")) machines.delete("YUKON");
  if (machines.has("CrossCut XP")) machines.delete("CrossCut");

  return Array.from(machines).join("; ");
}

async function getAssistantReply({ userMessage, sessionContext }) {
  const thread = await openai.beta.threads.create();
  const activeThreadId = thread.id;

  const contextText = `
Known session context:
Name: ${sessionContext.name || "Not provided yet"}
Company: ${sessionContext.company || "Not provided yet"}
Machine: ${sessionContext.machine || "Not provided yet"}

Important rules:
- The first user message is usually their name and company because the chatbot already asked for it.
- If name and company are already provided above, do not ask for them again.
- If machine is already provided above, do not ask the user to confirm the machine.
- If the user says a recognized Park Industries machine name, assume that is the machine they mean.
- If the machine is JAVELIN, assume they mean the JAVELIN CNC Sawjet. Do not ask them to confirm.
- Answer the user's service or maintenance question using the known machine context.
- Only ask for missing information if it is truly required to answer the question.
- If a safety, electrical, hydraulic, calibration-sensitive, or unclear service issue is involved, remind them to follow proper safety procedures and contact Park Industries service if needed.
`.trim();

  await openai.beta.threads.messages.create(activeThreadId, {
    role: "user",
    content: `${contextText}\n\nUser message:\n${userMessage}`
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
      const data = JSON.parse(text);
      return data;
    } catch (error) {
      return {
        success: true,
        action: "logged_non_json_response",
        note: "Google Apps Script completed but returned non-JSON."
      };
    }
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        success: false,
        action: "google_script_timeout",
        note: "Google Sheet logging timed out, but Ask Max response was returned."
      };
    }

    return {
      success: false,
      action: "google_script_error",
      error: error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}
