// CLI entry for the mock verifier:  npm run mock
// Env: MOCK_PORT (8765) MOCK_SCENARIO (auto|review|repair|block|unproven|always-repair)
//      MOCK_EVENT_DELAY_MS (400) MOCK_PRIMARY_DOWN (0|1)
import type { MockScenario } from "./mock-server";
import { startMockServer } from "./mock-server";

async function main(): Promise<void> {
  const server = await startMockServer({
    port: Number(process.env.MOCK_PORT ?? 8765),
    scenario: (process.env.MOCK_SCENARIO as MockScenario | undefined) ?? "auto",
    eventDelayMs: Number(process.env.MOCK_EVENT_DELAY_MS ?? 400),
    primaryDown: process.env.MOCK_PRIMARY_DOWN === "1",
  });
  console.log(`PCP mock verifier on ${server.url} (scenario=${process.env.MOCK_SCENARIO ?? "auto"})`);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
