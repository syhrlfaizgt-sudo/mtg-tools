import { runBot } from "./src/bot.js";

runBot().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
