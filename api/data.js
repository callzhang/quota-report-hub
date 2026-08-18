import {
  quotaHistoryHandlerImpl,
  tokenUsageHandlerImpl,
  tokenUsageQueryHandlerImpl,
  tokenUsageRetentionHandlerImpl,
} from "../lib/data-api.js";

const handlers = {
  "quota-history": quotaHistoryHandlerImpl,
  "token-usage": tokenUsageHandlerImpl,
  "token-usage-query": tokenUsageQueryHandlerImpl,
  "token-usage-retention": tokenUsageRetentionHandlerImpl,
};

export async function routeDataRequest(req, res, routes = handlers) {
  const url = new URL(req.url, "http://placeholder");
  const route = String(req.query?.route || url.searchParams.get("route") || "");
  const selected = routes[route];
  if (!selected) {
    res.statusCode = 404;
    res.end("Not Found");
    return;
  }
  url.searchParams.delete("route");
  req.url = `${url.pathname}${url.search}`;
  return selected(req, res);
}

export default async function handler(req, res) {
  return routeDataRequest(req, res);
}
