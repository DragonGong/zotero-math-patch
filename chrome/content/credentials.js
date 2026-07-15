(function (global) {
  "use strict";

  const ORIGIN = "chrome://zotero-math-patch";
  const REALM = "Zotero Math Patch API Key";
  const USERNAME = "openai-compatible";

  function createCredentialStore(services, components) {
    if (!services?.logins || !components?.Constructor || !components?.interfaces) {
      throw new Error("Firefox local credential storage is unavailable.");
    }

    const LoginInfo = components.Constructor(
      "@mozilla.org/login-manager/loginInfo;1",
      components.interfaces.nsILoginInfo,
      "init",
    );

    async function findStoredLogins() {
      const logins = typeof services.logins.searchLoginsAsync === "function"
        ? await services.logins.searchLoginsAsync({ origin: ORIGIN, httpRealm: REALM })
        : services.logins.findLogins(ORIGIN, null, REALM);
      return Array.from(logins || [])
        .filter((login) => login.username === USERNAME);
    }

    return {
      async get() {
        return (await findStoredLogins())[0]?.password || "";
      },

      async set(apiKey) {
        const value = String(apiKey || "");
        const existing = await findStoredLogins();
        for (const login of existing) {
          services.logins.removeLogin(login);
        }

        if (!value) {
          return;
        }

        const login = new LoginInfo(
          ORIGIN,
          null,
          REALM,
          USERNAME,
          value,
          "",
          "",
        );
        if (typeof services.logins.addLoginAsync === "function") {
          await services.logins.addLoginAsync(login);
        }
        else {
          services.logins.addLogin(login);
        }
      },
    };
  }

  const api = {
    ORIGIN,
    REALM,
    USERNAME,
    createCredentialStore,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  else {
    global.ZoteroMathPatchCredentials = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
