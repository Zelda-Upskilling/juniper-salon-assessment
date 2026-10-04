import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";

async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  });
  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: process.env.TASK_QUEUE || "juniper-salon",
    activities,
    workflowsPath: require.resolve("./workflows"),
  });
  console.log("Worker is polling the juniper-salon task queue.");
  await worker.run();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
