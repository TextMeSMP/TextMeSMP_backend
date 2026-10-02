import "dotenv/config";
import { sendDailyLessons } from "./dailySend";

async function main() {
  const result = await sendDailyLessons();
  console.log("Daily send finished:", result);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
