var chromeHandle;
var plugin;

if (typeof Zotero === "undefined") {
  var Zotero;
}

if (typeof Services === "undefined") {
  var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
}

function install() {}

async function waitForZotero() {
  if (typeof Zotero !== "undefined" && Zotero) {
    await Zotero.initializationPromise;
    return;
  }

  var windows = Services.wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    var win = windows.getNext();
    if (win.Zotero) {
      Zotero = win.Zotero;
      await Zotero.initializationPromise;
      return;
    }
  }

  await new Promise((resolve) => {
    var listener = {
      onOpenWindow(xulWindow) {
        var domWindow = xulWindow
          .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
          .getInterface(Components.interfaces.nsIDOMWindowInternal || Components.interfaces.nsIDOMWindow);

        domWindow.addEventListener(
          "load",
          function onLoad() {
            domWindow.removeEventListener("load", onLoad, false);
            if (domWindow.Zotero) {
              Services.wm.removeListener(listener);
              Zotero = domWindow.Zotero;
              resolve();
            }
          },
          false,
        );
      },
    };
    Services.wm.addListener(listener);
  });

  await Zotero.initializationPromise;
}

async function startup(data) {
  await waitForZotero();

  var id = data.id;
  var rootURI = data.rootURI || data.resourceURI?.spec;
  if (!rootURI) {
    throw new Error("Zotero Math Patch: missing add-on rootURI.");
  }

  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotero-math-patch", rootURI + "chrome/content/"],
  ]);

  var mainWindow = Zotero.getMainWindow();
  var domWindow = mainWindow || Services.appShell.hiddenDOMWindow;
  var sandboxConsole = domWindow.console || {
    log: (message) => Zotero.debug(String(message)),
    warn: (message) => Zotero.debug(String(message)),
    error: (error) => Zotero.logError(error),
  };
  var sandbox = {
    Zotero,
    Services,
    Components,
    ChromeUtils,
    IOUtils: domWindow.IOUtils,
    PathUtils: domWindow.PathUtils,
    DOMParser: domWindow.DOMParser,
    XMLSerializer: domWindow.XMLSerializer,
    NodeFilter: domWindow.NodeFilter,
    AbortController: domWindow.AbortController,
    URL: domWindow.URL,
    fetch: domWindow.fetch.bind(domWindow),
    setTimeout: domWindow.setTimeout.bind(domWindow),
    clearTimeout: domWindow.clearTimeout.bind(domWindow),
    console: sandboxConsole,
    rootURI,
    pluginID: id,
    pluginVersion: data.version,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/converter.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/settings.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/logger.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/credentials.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/ai-core.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/ai-provider.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/ai-workflow.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/ai-progress.js",
    sandbox,
  );
  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/math-renderer.js",
    sandbox,
  );

  plugin = sandbox.ZoteroMathPatch;
  await plugin.startup();
}

function onMainWindowLoad({ window }) {
  plugin?.onWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  plugin?.onWindowUnload(window);
}

async function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  await plugin?.shutdown();
  plugin = null;

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
