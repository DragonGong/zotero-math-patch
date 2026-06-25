var chromeHandle;
var plugin;

function install() {}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;

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
    DOMParser: domWindow.DOMParser,
    XMLSerializer: domWindow.XMLSerializer,
    NodeFilter: domWindow.NodeFilter,
    setTimeout: domWindow.setTimeout.bind(domWindow),
    clearTimeout: domWindow.clearTimeout.bind(domWindow),
    console: sandboxConsole,
    rootURI,
    pluginID: id,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  Services.scriptloader.loadSubScript(
    rootURI + "chrome/content/converter.js",
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

function shutdown(data, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  plugin?.shutdown();
  plugin = null;

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall() {}
