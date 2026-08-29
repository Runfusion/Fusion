import http from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";

type TestResponse = {
  status: number;
  body: unknown;
  /*
  FNXC:TestHarness 2026-07-10-12:30:
  Raw response bytes concatenated before any UTF-8 decoding. Binary/media route tests (e.g. artifact byte-range serving) must compare exact bytes, and per the no-real-network testing rule they ride this in-memory harness instead of spinning up a real TCP server.
  */
  bodyBuffer: Buffer;
  headers: http.OutgoingHttpHeaders;
};

class MockSocket extends PassThrough {
  public writable = true;
  public readable = true;
  public remoteAddress = "127.0.0.1";
  public encrypted = false;

  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  destroySoon(): void {
    this.destroy();
  }
}

function normalizeBody(body: Buffer | string | undefined): Buffer | undefined {
  if (body === undefined) return undefined;
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

export async function request(
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  method: string,
  path: string,
  body?: Buffer | string,
  headers: Record<string, string> = {},
  rawBody: Buffer | undefined = undefined,
): Promise<TestResponse> {
  const normalizedBody = normalizeBody(body);
  const socket = new MockSocket();
  socket.resume();
  const req = new http.IncomingMessage(socket as unknown as Socket);
  const res = new http.ServerResponse(req);
  const chunks: Buffer[] = [];

  req.method = method;
  req.url = path;
  req.httpVersion = "1.1";
  req.headers = Object.fromEntries(
    Object.entries({
      host: "127.0.0.1",
      ...headers,
      ...(normalizedBody ? { "content-length": String(normalizedBody.length) } : {}),
    }).map(([key, value]) => [key.toLowerCase(), value]),
  );

  res.assignSocket(socket as unknown as Socket);

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = ((chunk: string | Buffer, encoding?: BufferEncoding | ((error?: Error | null) => void), cb?: (error?: Error | null) => void) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    originalWrite(chunk as never, encoding as never, cb);
    return true;
  }) as typeof res.write;

  res.end = ((chunk?: string | Buffer, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    }
    const callback = typeof encoding === "function" ? encoding : cb;
    return originalEnd(chunk as never, encoding as never, callback as never);
  }) as typeof res.end;

  const response = new Promise<TestResponse>((resolve, reject) => {
    res.on("finish", () => {
      const bodyBuffer = Buffer.concat(chunks);
      const rawBody = bodyBuffer.toString("utf8");
      const contentType = res.getHeader("content-type");
      const shouldParseJson = typeof contentType === "string" && contentType.includes("application/json");

      try {
        resolve({
          status: res.statusCode,
          body: shouldParseJson && rawBody.length > 0 ? JSON.parse(rawBody) : rawBody,
          bodyBuffer,
          headers: res.getHeaders(),
        });
      } catch (error) {
        reject(error);
      }
    });

    res.on("error", reject);
  });

  if (rawBody) {
    (req as http.IncomingMessage & { rawBody?: Buffer }).rawBody = rawBody;
  }

  app(req, res);

  process.nextTick(() => {
    if (normalizedBody) {
    req.emit("data", normalizedBody);
    }
    req.complete = true;
    req.emit("end");
  });

  return response;
}

export async function get(
  app: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  path: string,
): Promise<TestResponse> {
  return request(app, "GET", path);
}
