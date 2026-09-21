/**
 * Runtime entrypoint for the Telegram bot.
 *
 * Keep transport/runtime wiring here so future features can be added under
 * src/features/ without making main.js grow into a second application file.
 */
export { runBot } from "./features/tracker.js";
