import { HttpClient } from "../node_modules/@libsql/client/lib-esm/http.js";

console.log(JSON.stringify({ diagnostic: "database_startup", node: process.version, database_host: new URL(process.env.TURSO_DATABASE_URL).hostname }));

const execute = HttpClient.prototype.execute;
let query = 0;
HttpClient.prototype.execute = async function (statement, args) {
  const sql = (typeof statement === "string" ? statement : statement.sql).trim().replace(/\s+/g, " ");
  const ordinal = ++query;
  const started = Date.now();
  try {
    const result = await execute.call(this, statement, args);
    console.log(JSON.stringify({ diagnostic: "database_query", query: ordinal, sql: sql.slice(0, 120), elapsed_ms: Date.now() - started, ok: true }));
    return result;
  } catch (error) {
    console.log(JSON.stringify({ diagnostic: "database_query", query: ordinal, sql: sql.slice(0, 120), elapsed_ms: Date.now() - started, ok: false, error: error.message, code: error.code || error.cause?.code }));
    throw error;
  }
};
