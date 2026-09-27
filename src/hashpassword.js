const bcrypt = require("bcryptjs");

async function run() {
  const plain = process.env.PASSWORD_TO_HASH;
  if (!plain) {
    throw new Error("Set PASSWORD_TO_HASH for this one-time command");
  }

  const hash = await bcrypt.hash(plain, 10);

  console.log("Hashed password:", hash);
}

run().catch(console.error);
