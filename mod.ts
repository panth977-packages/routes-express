/**
 * Express Server for "@panth977/routes";
 *
 * @module
 *
 * @example
 * ```ts
 * import createHttpError from "http-errors";
 * import { R } from "@panth977/routes";
 * import { serve, type onError } from "@panth977/routes-express";
 * import * as routes_ from './routes/index.ts';
 * import express from 'express';
 *
 * function onError(context, build, error) {
 *   if (createHttpError.isHttpError(error)) return error;
 *   if (context) {
 *     context.log('Request Error:', error);
 *   } else {
 *     console.error('Request Error:', error);
 *   }
 *   return createHttpError.InternalServerError('Something went wrong!');
 * } satisfies onError;
 *
 * const app = express();
 * const routes = R.getEndpointsFromBundle(routes_); // strong type will be lost
 * app.use(serve(routes, onError));
 * app.listen(8080, () => console.log('Listing...'));
 * ```
 */

import { type Request, type Response, Router } from "express";
import { F } from "@panth977/functions";
import { R } from "@panth977/routes";
import { z } from "zod/v4";

function pathParser<
  I extends R.HttpInput,
  O extends R.HttpOutput,
  D extends F.FuncDeclaration,
  Type extends R.HttpTypes,
>(path: string, schema: R.FuncHttp<I, O, D, Type>["reqPath"]): string {
  if (schema instanceof z.ZodObject) {
    return path.replace(/{([^}]+)}/g, (_, x) => {
      const s = schema.shape[x];
      if (s instanceof z.ZodEnum) {
        const enums = Object.keys(s.enum).join("|");
        return `:${x}(${enums})`;
      }
      if (s instanceof z.ZodNumber) {
        return `:${x}(\\d+)`;
      }
      return `:${x}`;
    });
  }
  return path.replace(/{([^}]+)}/g, ":$1");
}
export const ExpressState: F.ContextState<[Request, Response]> =
  F.ContextState.Tree<[Request, Response]>("Middleware", "create&read");
export class ExpressHttpContext extends R.HttpContext {
  static debug = false;
  protected static onError(error: unknown) {
    if (this.debug) {
      console.error(error);
    }
  }
  constructor(
    requestId: string,
    readonly Request: Request,
    readonly Response: Response,
    readonly onError: (err: unknown) => {
      status: number;
      headers?: Record<string, string[] | string>;
      message: string;
    },
  ) {
    super(requestId, `${Request.method}, ${Request.url}`);
    ExpressState.set(this, [Request, Response]);
  }
  override get req(): {
    headers: Record<string, string | string[]>;
    path: Record<string, string>;
    query: Record<string, string | string[]>;
    body: any;
  } {
    return {
      headers: this.Request.headers,
      path: this.Request.params,
      query: this.Request.query,
      body: this.Request.body,
    };
  }
  private exposedHeaders: string[] = [];
  override setResHeaders(headers: Record<string, string | string[]>): void {
    for (const key in headers) {
      this.Response.setHeader(key, headers[key]);
      this.exposedHeaders.push(key);
    }
  }
  override endWithData(
    contentType: "application/json" | (string & Record<never, never>),
    content: unknown,
  ): void {
    this.Response.setHeader("Access-Control-Allow-Origin", "*");
    if (this.exposedHeaders.length) {
      this.Response.setHeader(
        "Access-Control-Expose-Headers",
        this.exposedHeaders.join(", "),
      );
    }
    this.Response.status(200);
    if (contentType === "application/json") {
      this.Response.json(content);
    } else {
      this.Response.send(content);
    }
    this.Response.end();
  }
  override endedWithError(err: unknown): void {
    try {
      const { message, status, headers } = this.onError(err);
      if (headers) this.setResHeaders(headers);
      this.Response.status(status).json(message);
    } catch (err) {
      ExpressHttpContext.onError(err);
      this.Response.status(500).json("Unknown Server Error!");
    }
  }
}

export class ExpressSseContext extends R.SseContext {
  static debug = false;
  protected static onError(error: unknown) {
    if (this.debug) {
      console.error(error);
    }
  }
  constructor(
    requestId: string,
    readonly Request: Request,
    readonly Response: Response,
    readonly onError: (err: unknown) => string,
  ) {
    super(requestId, `${Request.method}, ${Request.url}`);
    ExpressState.set(this, [Request, Response]);
    Response.setHeader("Cache-Control", "no-cache");
    Response.setHeader("Content-Type", "text/event-stream");
    Response.setHeader("Access-Control-Allow-Origin", "*");
    Response.setHeader("Connection", "keep-alive");
    Response.flushHeaders();
  }
  override get req(): {
    path: Record<string, string>;
    query: Record<string, string | string[]>;
  } {
    return {
      path: this.Request.params,
      query: this.Request.query,
    };
  }
  override send(data: string): void {
    this.Response.write(`data: ${data}\n\n`);
    this.Response.flush?.();
  }

  override endedWithError(err: unknown): void {
    this.Response.write(`data: ${this.onError(err)}\n\n`);
    this.Response.flush?.();
    this.Response.end();
  }

  override endedWithSuccess(): void {
    this.Response.end();
  }
}

type GenReqId = (req: Request, res: Response) => string;
export function executeHttpRoute<
  I extends R.HttpInput,
  O extends R.HttpOutput,
  D extends F.FuncDeclaration,
  Type extends R.HttpTypes,
>(
  genRequestId: GenReqId,
  http: R.FuncHttpExported<I, O, D, Type>,
  onError: ExpressHttpContext["onError"],
  onContextInit: onContextInit,
  req: Request,
  res: Response,
): void {
  const requestId = genRequestId(req, res);
  const context = new ExpressHttpContext(requestId, req, res, onError);
  onContextInit(context);
  const executor = new R.HttpExecutor(context, http);
  res.on("close", executor.cancel.bind(executor));
  executor.start();
}
export function executeSseRoute<
  I extends R.SseInput,
  O extends R.SseOutput,
  D extends F.FuncDeclaration,
  Type extends R.SseTypes,
>(
  genRequestId: GenReqId,
  sse: R.FuncSseExported<I, O, D, Type>,
  onError: ExpressSseContext["onError"],
  onContextInit: onContextInit,
  req: Request,
  res: Response,
): void {
  const requestId = genRequestId(req, res);
  const context = new ExpressSseContext(requestId, req, res, onError);
  onContextInit(context);
  const executor = new R.SseExecutor(context, sse);
  res.on("close", executor.cancel.bind(executor));
  executor.start();
}
type onContextInit = (c: ExpressSseContext | ExpressHttpContext) => void;
/**
 * creates a "express" Router that serves all the given endpoints bundle
 * @param bundle
 * @param onError
 * @returns
 *
 * @example
 * ```ts
 * const lifecycle = createLifeCycle(onError);
 * app.use('/v1', serve({bundle: bundledRoutes, buildHandler: (build) => defaultBuildHandler({build, lc: lifecycle})}));
 * ```
 */
export function serve({
  bundle,
  genRequestId,
  onHttpError,
  onSseError,
  onContextInit,
}: {
  genRequestId: GenReqId;
  bundle: Record<string, R.EndpointBuild>;
  onHttpError?: ExpressHttpContext["onError"];
  onSseError?: ExpressSseContext["onError"];
  onContextInit: onContextInit;
}): Router {
  const router = Router();
  for (const build of Object.values(bundle).sort(
    (x, y) => x.node.docsOrder - y.node.docsOrder,
  )) {
    let route: (req: Request, res: Response) => void;
    if (build.node instanceof R.FuncHttp) {
      if (!onHttpError) {
        throw new Error("Need [onHttpError] for the http routes.");
      }
      route = executeHttpRoute.bind(
        null,
        genRequestId,
        build as any,
        onHttpError,
        onContextInit,
      );
    } else if (build.node instanceof R.FuncSse) {
      if (!onSseError) {
        throw new Error("Need [onSseError] for the http routes.");
      }
      route = executeSseRoute.bind(
        null,
        genRequestId,
        build as any,
        onSseError,
        onContextInit,
      );
    } else {
      throw new Error("Unknown Build type found.");
    }
    for (const path of build.node.paths) {
      for (const method of build.node.methods) {
        router[method](pathParser(path, build.node.reqPath), route);
      }
    }
  }
  return router;
}
