import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { hostAgentCall } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const [method, ...rest] = process.argv.slice(2);
if (!method) {
  console.error("Usage: npm run cli -- ping|list|inspect <serverId>|restart <serverId> <port>");
  process.exit(1);
}

async function main(): Promise<void> {
  switch (method) {
    case "ping":
      console.log(await hostAgentCall("ping"));
      break;
    case "list":
      console.log(JSON.stringify(await hostAgentCall("list"), null, 2));
      break;
    case "inspect":
      console.log(await hostAgentCall("inspect", { serverId: rest[0] }));
      break;
    case "restart":
      console.log(
        await hostAgentCall("restart", {
          serverId: rest[0],
          hostPort: Number(rest[1]),
        }),
      );
      break;
    case "stop":
      console.log(await hostAgentCall("stop", { serverId: rest[0] }));
      break;
    default:
      console.error(`unknown command: ${method}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
