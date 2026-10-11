import { spawn } from "node:child_process";

const role = process.env.QWAKK_PROCESS_ROLE === "indexer" ? "indexer" : "web";
const command = role === "indexer"
  ? ["node", ["--import", "tsx", "indexer/server.ts"]]
  : ["npm", ["run", "start", "--", "--hostname", "0.0.0.0", "--port", process.env.PORT || "3000"]];

const child = spawn(command[0], command[1], { stdio: "inherit", env: process.env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
