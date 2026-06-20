import type express from "express";

// Express 4 does not catch rejections from async route handlers — an unhandled
// rejection there hangs the request and (without a process guard) can crash the
// process. Wrap async handlers so any rejection is forwarded to the error middleware.
export function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
