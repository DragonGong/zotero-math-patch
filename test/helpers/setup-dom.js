const { parseHTML } = require("linkedom");

global.DOMParser = class {
  parseFromString(html) {
    return parseHTML("<html><body>" + html + "</body></html>").document;
  }
};

global.NodeFilter = {
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
};
