(function () {
  const modules = document.querySelectorAll(".ask-max-module");

  modules.forEach(function (moduleRoot, index) {
    const form = moduleRoot.querySelector("[data-ask-max-form]");
    const input = moduleRoot.querySelector("[data-ask-max-input]");
    const messages = moduleRoot.querySelector("[data-ask-max-messages]");
    const status = moduleRoot.querySelector("[data-ask-max-status]");
    const sendButton = moduleRoot.querySelector(".ask-max-send");

    if (!form || !input || !messages || !sendButton) return;

    const endpoint =
      moduleRoot.dataset.endpoint ||
      "https://askmax-pi.netlify.app/.netlify/functions/ask-max-chat";

    const storagePrefix = "askMax_" + index + "_";
    const sessionIdKey = storagePrefix + "sessionId";
    const threadIdKey = storagePrefix + "threadId";
    const startedAtKey = storagePrefix + "startedAt";
    const nameKey = storagePrefix + "name";
    const companyKey = storagePrefix + "company";
    const machineKey = storagePrefix + "machine";

    let isSending = false;

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      sendMessage();
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    input.addEventListener("input", autoResizeInput);

    function addMessage(text, type, options) {
      const message = document.createElement("div");
      message.className = "ask-max-message ask-max-" + type;

      if (options && options.extraClass) {
        message.classList.add(options.extraClass);
      }

      if (options && options.html) {
        message.innerHTML = options.html;
      } else {
        message.innerHTML = linkifyText(text);
      }

      messages.appendChild(message);
      scrollToBottom();

      return message;
    }

    function addTypingMessage() {
      return addMessage("", "bot", {
        extraClass: "ask-max-loading",
        html:
          '<span class="ask-max-typing" aria-label="Max is thinking">' +
          "<span></span><span></span><span></span>" +
          "</span>"
      });
    }

    async function sendMessage() {
      if (isSending) {
        return;
      }

      const userMessage = input.value.trim();

      if (!userMessage) {
        setStatus("Please type a message first.");
        return;
      }

      isSending = true;

      const sessionId = sessionStorage.getItem(sessionIdKey);
      const threadId = sessionStorage.getItem(threadIdKey);
      const startedAt = sessionStorage.getItem(startedAtKey);

      const savedName = sessionStorage.getItem(nameKey) || "";
      const savedCompany = sessionStorage.getItem(companyKey) || "";
      const savedMachine = sessionStorage.getItem(machineKey) || "";

      addMessage(userMessage, "user");

      input.value = "";
      autoResizeInput();

      sendButton.disabled = true;
      input.disabled = true;
      setStatus("");

      const typingMessage = addTypingMessage();

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          mode: "cors",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sessionId: sessionId,
            threadId: threadId,
            startedAt: startedAt,
            message: userMessage,
            name: savedName,
            company: savedCompany,
            machine: savedMachine
          })
        });

        const responseText = await response.text();

        let data;

        try {
          data = JSON.parse(responseText);
        } catch (error) {
          throw new Error(
            "Server returned non-JSON response: " + responseText.slice(0, 250)
          );
        }

        if (!response.ok) {
          throw new Error(data.details || data.error || "Request failed.");
        }

        if (data.sessionId) {
          sessionStorage.setItem(sessionIdKey, data.sessionId);
        }

        if (data.threadId) {
          sessionStorage.setItem(threadIdKey, data.threadId);
        }

        if (data.startedAt) {
          sessionStorage.setItem(startedAtKey, data.startedAt);
        }

        if (data.name) {
          sessionStorage.setItem(nameKey, data.name);
        }

        if (data.company) {
          sessionStorage.setItem(companyKey, data.company);
        }

        if (data.machine) {
          sessionStorage.setItem(machineKey, data.machine);
        }

        typingMessage.remove();

        addMessage(
          data.reply || "Sorry, I was not able to generate a response.",
          "bot"
        );

        setStatus("");
      } catch (error) {
        typingMessage.remove();

        addMessage(
          "Sorry, something went wrong. Please try again or contact our service team for support.",
          "bot"
        );

        setStatus("Error: " + error.message);
        console.error("Ask Max error:", error);
      } finally {
        isSending = false;
        sendButton.disabled = false;
        input.disabled = false;
        input.focus();
      }
    }

    function setStatus(text) {
      if (status) {
        status.textContent = text || "";
      }
    }

    function autoResizeInput() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 130) + "px";
    }

    function scrollToBottom() {
      messages.scrollTop = messages.scrollHeight;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function linkifyText(text) {
      const escaped = escapeHtml(text || "");
      const urlRegex = /(https?:\/\/[^\s<]+)/g;

      return escaped.replace(urlRegex, function (url) {
        const cleanUrl = url.replace(/[),.]+$/, "");
        const trailing = url.slice(cleanUrl.length);

        return (
          '<a href="' +
          cleanUrl +
          '" target="_blank" rel="noopener noreferrer">' +
          cleanUrl +
          "</a>" +
          trailing
        );
      });
    }
  });
})();
