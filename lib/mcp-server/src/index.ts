import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, openDatabase, DataStore } from "@workspace/nlp-runner";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

function createStore(): DataStore {
  const config = loadConfig();
  const db = openDatabase(config.dataDir);
  return new DataStore(db);
}

const handle = serveStdio(() => {
  const store = createStore();
  const server = new McpServer({
    name: "testradius",
    version: "1.0.0",
  });

  registerTools(server, store);
  registerResources(server, store);

  return server;
});

process.on("SIGINT", () => {
  void handle.close();
});
