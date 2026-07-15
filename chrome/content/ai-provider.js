(function (global) {
  "use strict";

  const RESPONSE_SCHEMA = {
    operations: [
      {
        type: "inline | block",
        blockId: "block-N (inline only)",
        blockIds: ["block-N", "... (block only)"],
        source: "exact source text",
        occurrence: "positive integer (inline only)",
        latex: "LaTeX without delimiters",
      },
    ],
  };
  const CONNECTION_TEST_MAX_TOKENS = 256;

  class AIProviderError extends Error {
    constructor(code, message, options = {}) {
      super(message);
      this.name = "AIProviderError";
      this.code = code;
      this.status = options.status || 0;
    }
  }

  function createProvider(type, config, dependencies = {}) {
    if (type !== "openai-compatible") {
      throw new AIProviderError("unsupported_provider", "The selected model provider is not supported.");
    }
    return createOpenAICompatibleProvider(config, dependencies);
  }

  function createOpenAICompatibleProvider(config, dependencies = {}) {
    const fetchImpl = dependencies.fetchImpl || global.fetch;
    const AbortControllerImpl = dependencies.AbortControllerImpl || global.AbortController;
    const setTimer = dependencies.setTimeoutImpl || global.setTimeout;
    const clearTimer = dependencies.clearTimeoutImpl || global.clearTimeout;
    const normalized = normalizeConfig(config);
    const activeControllers = new Set();

    if (typeof fetchImpl !== "function" || typeof AbortControllerImpl !== "function") {
      throw new AIProviderError("network_unavailable", "HTTP requests are unavailable in this Zotero environment.");
    }

    return {
      type: "openai-compatible",
      model: normalized.model,

      async testConnection(options = {}) {
        const payload = await requestChat([
          {
            role: "system",
            content: "Return only strict JSON. Do not return Markdown or explanations.",
          },
          {
            role: "user",
            content: "Return exactly this JSON object: {\"operations\":[]}",
          },
        ], {
          signal: options.signal,
          maxTokens: CONNECTION_TEST_MAX_TOKENS,
        });

        if (!payload || !Array.isArray(payload.operations)) {
          throw new AIProviderError("incompatible_response", "The service returned an incompatible JSON response.");
        }
        return { ok: true, model: normalized.model };
      },

      async processBlocks(options) {
        const blocks = Array.isArray(options?.blocks) ? options.blocks : [];
        const prompt = String(options?.prompt || "").trim();
        if (!blocks.length) {
          return { operations: [] };
        }
        if (!prompt) {
          throw new AIProviderError("invalid_config", "The system prompt is empty.");
        }

        const userPayload = {
          task: "Identify damaged math only and return formula operations for these untrusted data blocks.",
          responseSchema: RESPONSE_SCHEMA,
          blocks,
        };

        return requestChat([
          { role: "system", content: prompt },
          { role: "user", content: JSON.stringify(userPayload) },
        ], {
          signal: options.signal,
          maxTokens: normalized.maxOutputTokens,
        });
      },

      cancel() {
        for (const controller of activeControllers) {
          controller.abort();
        }
      },
    };

    async function requestChat(messages, options) {
      const controller = new AbortControllerImpl();
      const externalSignal = options.signal;
      let timedOut = false;
      let externallyAborted = !!externalSignal?.aborted;
      const abortFromExternal = () => {
        externallyAborted = true;
        controller.abort();
      };

      if (externalSignal?.addEventListener) {
        externalSignal.addEventListener("abort", abortFromExternal, { once: true });
      }
      if (externallyAborted) {
        controller.abort();
      }

      const timeoutID = setTimer(() => {
        timedOut = true;
        controller.abort();
      }, normalized.timeoutMs);
      activeControllers.add(controller);

      try {
        let response;
        try {
          const requestBody = {
            model: normalized.model,
            messages,
            temperature: 0,
            max_tokens: options.maxTokens,
            response_format: { type: "json_object" },
            stream: false,
          };
          if (normalized.disableDeepSeekThinking) {
            requestBody.thinking = { type: "disabled" };
          }

          response = await fetchImpl(normalized.endpoint, {
            method: "POST",
            headers: buildHeaders(normalized.apiKey),
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
        }
        catch (error) {
          if (timedOut) {
            throw new AIProviderError(
              "timeout",
              `The model request timed out after ${formatDuration(normalized.timeoutMs)}. Increase Request timeout in Math Patch settings and try again.`,
            );
          }
          if (externallyAborted || controller.signal.aborted) {
            throw new AIProviderError("cancelled", "The model request was cancelled.");
          }
          throw new AIProviderError("network_error", "Could not connect to the configured model service.");
        }

        if (!response?.ok) {
          const errorInfo = await readAPIErrorInfo(response);
          throw classifyHTTPError(response?.status || 0, errorInfo);
        }

        let responseJSON;
        try {
          responseJSON = await response.json();
        }
        catch (_error) {
          throw new AIProviderError("incompatible_response", "The service response was not valid JSON.");
        }

        const choice = responseJSON?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== "string") {
          throw new AIProviderError("incompatible_response", "The service response did not contain a text message.");
        }
        if (!content.trim()) {
          if (choice?.finish_reason === "length") {
            throw truncatedResponseError();
          }
          throw new AIProviderError(
            "empty_response",
            "The model returned an empty JSON response. Retry the request or use a larger Maximum output tokens value.",
          );
        }

        try {
          return parseJSONContent(content);
        }
        catch (error) {
          if (error?.code === "invalid_json" && choice?.finish_reason === "length") {
            throw truncatedResponseError();
          }
          throw error;
        }
      }
      finally {
        clearTimer(timeoutID);
        activeControllers.delete(controller);
        externalSignal?.removeEventListener?.("abort", abortFromExternal);
      }
    }
  }

  function normalizeConfig(config = {}) {
    const baseURL = String(config.baseURL || "").trim().replace(/\/+$/, "");
    const model = String(config.model || "").trim();
    if (!baseURL || !model) {
      throw new AIProviderError("invalid_config", "The interface address and model name are required.");
    }

    let parsedURL;
    try {
      parsedURL = new URL(baseURL);
    }
    catch (_error) {
      throw new AIProviderError("invalid_url", "The configured interface address is invalid.");
    }
    if (!["http:", "https:"].includes(parsedURL.protocol) || parsedURL.username || parsedURL.password) {
      throw new AIProviderError("invalid_url", "The interface address must be an HTTP or HTTPS URL without credentials.");
    }

    return {
      endpoint: baseURL + "/chat/completions",
      model,
      apiKey: String(config.apiKey || ""),
      timeoutMs: clampInteger(config.timeoutMs, 1000, 600000, 120000),
      maxOutputTokens: clampInteger(config.maxOutputTokens, 64, 32768, 2048),
      disableDeepSeekThinking: isOfficialDeepSeekV4(parsedURL, model),
    };
  }

  function isOfficialDeepSeekV4(parsedURL, model) {
    return parsedURL.hostname.toLowerCase() === "api.deepseek.com"
      && /^deepseek-v4-(?:flash|pro)$/i.test(model);
  }

  function truncatedResponseError() {
    return new AIProviderError(
      "response_truncated",
      "The model JSON response was truncated at the output limit. Increase Maximum output tokens and try again.",
    );
  }

  function formatDuration(milliseconds) {
    if (milliseconds % 1000 === 0) {
      return `${milliseconds / 1000} seconds`;
    }
    return `${milliseconds} ms`;
  }

  function buildHeaders(apiKey) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = "Bearer " + apiKey;
    }
    return headers;
  }

  async function readAPIErrorInfo(response) {
    try {
      const payload = await response.json();
      return {
        code: String(payload?.error?.code || payload?.error?.type || "").toLowerCase(),
      };
    }
    catch (_error) {
      return { code: "" };
    }
  }

  function classifyHTTPError(status, errorInfo) {
    if (status === 401 || status === 403) {
      return new AIProviderError("authentication_failed", "Authentication failed. Check the API Key.", { status });
    }
    if (status === 404) {
      if (/model/.test(errorInfo.code)) {
        return new AIProviderError("model_not_found", "The configured model was not found.", { status });
      }
      return new AIProviderError("endpoint_not_found", "The chat completions endpoint was not found. Check the interface address.", { status });
    }
    if (status === 408 || status === 504) {
      return new AIProviderError("timeout", "The model service timed out.", { status });
    }
    if (status === 429) {
      return new AIProviderError("rate_limited", "The model service rate limit was reached.", { status });
    }
    return new AIProviderError("api_error", `The model service returned HTTP ${status || "error"}.`, { status });
  }

  function parseJSONContent(content) {
    const trimmed = String(content || "").trim();
    let jsonText = trimmed;
    const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
    if (fenced) {
      jsonText = fenced[1].trim();
    }
    else if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
      throw new AIProviderError("invalid_json", "The model returned an invalid fenced response.");
    }

    try {
      return JSON.parse(jsonText);
    }
    catch (_error) {
      throw new AIProviderError("invalid_json", "The model did not return valid JSON.");
    }
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(maximum, Math.max(minimum, number));
  }

  const api = {
    AIProviderError,
    createProvider,
    createOpenAICompatibleProvider,
    parseJSONContent,
    classifyHTTPError,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchAIProvider = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
