async function run() {
  require("./converter.test.js");
  await require("./settings.test.js")();
  await require("./credentials.test.js")();
  await require("./preferences.test.js")();
  await require("./preview.test.js")();
  await require("./ai-core.test.js")();
  await require("./provider.test.js")();
  await require("./workflow.test.js")();
  console.log("all tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
