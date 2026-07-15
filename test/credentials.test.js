const assert = require("node:assert/strict");
const {
  ORIGIN,
  REALM,
  USERNAME,
  createCredentialStore,
} = require("../chrome/content/credentials.js");

module.exports = async function runCredentialTests() {
  await testFirefox140LoginManager();
  await testLegacyLoginManagerFallback();
  console.log("credential tests passed");
};

async function testFirefox140LoginManager() {
  const logins = [createLogin(USERNAME, "stored-secret")];
  const queries = [];
  let asyncAdds = 0;
  let syncAdds = 0;
  const services = {
    logins: {
      async searchLoginsAsync(query) {
        queries.push(query);
        return logins.filter((login) => login.origin === query.origin && login.httpRealm === query.httpRealm);
      },
      removeLogin(login) {
        logins.splice(logins.indexOf(login), 1);
      },
      async addLoginAsync(login) {
        asyncAdds += 1;
        logins.push(login);
      },
      addLogin() {
        syncAdds += 1;
      },
    },
  };
  const store = createCredentialStore(services, createComponents());

  assert.equal(await store.get(), "stored-secret");
  await store.set("replacement-secret");
  assert.equal(await store.get(), "replacement-secret");
  assert.equal(asyncAdds, 1);
  assert.equal(syncAdds, 0);
  assert.deepEqual(queries[0], { origin: ORIGIN, httpRealm: REALM });

  await store.set("");
  assert.equal(await store.get(), "");
}

async function testLegacyLoginManagerFallback() {
  const logins = [];
  let syncAdds = 0;
  const services = {
    logins: {
      findLogins(origin, _formActionOrigin, realm) {
        return logins.filter((login) => login.origin === origin && login.httpRealm === realm);
      },
      removeLogin(login) {
        logins.splice(logins.indexOf(login), 1);
      },
      addLogin(login) {
        syncAdds += 1;
        logins.push(login);
      },
    },
  };
  const store = createCredentialStore(services, createComponents());

  await store.set("legacy-secret");
  assert.equal(await store.get(), "legacy-secret");
  assert.equal(syncAdds, 1);
}

function createComponents() {
  return {
    interfaces: { nsILoginInfo: {} },
    Constructor() {
      return class LoginInfo {
        constructor(origin, formActionOrigin, httpRealm, username, password) {
          Object.assign(this, { origin, formActionOrigin, httpRealm, username, password });
        }
      };
    },
  };
}

function createLogin(username, password) {
  return {
    origin: ORIGIN,
    httpRealm: REALM,
    username,
    password,
  };
}
