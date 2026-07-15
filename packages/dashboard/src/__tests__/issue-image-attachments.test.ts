import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/*
FNXC:IssueImportAttachments 2026-07-15-11:20:
Surface enumeration for "an imported issue's images reach the agent":
- markdown `![](...)` images (the upload default) and raw `<img src>` (authors resizing a screenshot)
- GitHub `user-attachments/assets/<uuid>` (current host, extension-less) + legacy `user-images.githubusercontent.com`
- GitLab relative `/uploads/<sha>/f.png` (project-rooted), `/-/project/<id>/uploads/...` (instance-rooted), absolute instance URLs
- images in COMMENTS as well as the body (2026-07-15-13:40)
- non-image forge links in the same body (must NOT be downloaded)
- foreign hosts / non-https / other GitLab instances (must NOT be downloaded — SSRF)
- oversized / non-image / failing downloads (must not fail the import)
Both forges' import routes call the same helper, so the helper + its policies are the invariant boundary; the route wiring is covered in routes-github.test.ts / routes-gitlab.test.ts.
*/

vi.mock("@fusion/core", () => ({
  isGhAvailable: () => false,
  isGhAuthenticated: () => false,
  runGhAsync: vi.fn(async () => ""),
}));

const { extractIssueImageUrls, importIssueImageAttachments, githubImagePolicy, gitlabImagePolicy } =
  await import("../issue-image-attachments.js");

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const GH = githubImagePolicy();
const GL = gitlabImagePolicy({
  webBaseUrl: "https://gitlab.example.com",
  webUrl: "https://gitlab.example.com/ns/proj/-/issues/12",
  token: "glpat-secret",
  headerName: "PRIVATE-TOKEN",
});

function imageResponse(mimeType = "image/png", body: Buffer = PNG) {
  return {
    ok: true,
    headers: new Headers({ "content-type": mimeType, "content-length": String(body.length) }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

describe("extractIssueImageUrls — GitHub policy", () => {
  it("extracts markdown images from the current user-attachments host", () => {
    const body = "Repro:\n\n![screenshot](https://github.com/user-attachments/assets/abc-123)";
    expect(extractIssueImageUrls(body, GH)).toEqual([
      "https://github.com/user-attachments/assets/abc-123",
    ]);
  });

  it("extracts raw <img src> images", () => {
    const body = '<img width="600" src="https://user-images.githubusercontent.com/1/a.png" />';
    expect(extractIssueImageUrls(body, GH)).toEqual([
      "https://user-images.githubusercontent.com/1/a.png",
    ]);
  });

  it("ignores ordinary github.com links that are not attachments", () => {
    const body = "See [#12](https://github.com/o/r/issues/12) and ![x](https://github.com/o/r/pull/3)";
    expect(extractIssueImageUrls(body, GH)).toEqual([]);
  });

  it("ignores non-GitHub hosts and non-https URLs", () => {
    const body = "![x](https://evil.example.com/a.png)\n![y](http://github.com/user-attachments/assets/z)";
    expect(extractIssueImageUrls(body, GH)).toEqual([]);
  });

  it("dedupes repeated URLs and caps the per-issue count", () => {
    const dupe = "![a](https://github.com/user-attachments/assets/same)".repeat(3);
    expect(extractIssueImageUrls(dupe, GH)).toHaveLength(1);

    const many = Array.from(
      { length: 25 },
      (_, i) => `![a](https://github.com/user-attachments/assets/id-${i})`,
    ).join("\n");
    expect(extractIssueImageUrls(many, GH)).toHaveLength(10);
  });

  it("handles empty and null bodies", () => {
    expect(extractIssueImageUrls(null, GH)).toEqual([]);
    expect(extractIssueImageUrls("", GH)).toEqual([]);
    expect(extractIssueImageUrls("no images here", GH)).toEqual([]);
  });

  /*
  FNXC:IssueImportAttachments 2026-07-15-13:40:
  "Here's the screenshot" is a COMMENT far more often than it is the original body — a body-only scan misses the common case.
  */
  it("collects images across the body and every comment, in order", () => {
    const urls = extractIssueImageUrls(
      [
        "body ![a](https://github.com/user-attachments/assets/one)",
        null,
        "comment ![b](https://github.com/user-attachments/assets/two)",
      ],
      GH,
    );
    expect(urls).toEqual([
      "https://github.com/user-attachments/assets/one",
      "https://github.com/user-attachments/assets/two",
    ]);
  });

  it("dedupes an image quoted from the body into a comment", () => {
    const same = "![a](https://github.com/user-attachments/assets/same)";
    expect(extractIssueImageUrls([same, `quoting: ${same}`], GH)).toHaveLength(1);
  });
});

describe("extractIssueImageUrls — GitLab policy", () => {
  /*
  FNXC:IssueImportAttachments 2026-07-15-13:40:
  GitLab's relative `/uploads/...` resolves against the PROJECT, not the instance root — the single most likely thing to get wrong here, and it 404s silently if it is.
  */
  it("resolves relative /uploads against the project, not the instance root", () => {
    expect(extractIssueImageUrls("![shot](/uploads/abc123/bug.png)", GL)).toEqual([
      "https://gitlab.example.com/ns/proj/uploads/abc123/bug.png",
    ]);
  });

  it("resolves instance-rooted /-/project uploads against the origin", () => {
    expect(extractIssueImageUrls("![shot](/-/project/7/uploads/abc/bug.png)", GL)).toEqual([
      "https://gitlab.example.com/-/project/7/uploads/abc/bug.png",
    ]);
  });

  it("accepts absolute URLs on the configured instance", () => {
    expect(
      extractIssueImageUrls("![s](https://gitlab.example.com/ns/proj/uploads/abc/bug.png)", GL),
    ).toEqual(["https://gitlab.example.com/ns/proj/uploads/abc/bug.png"]);
  });

  it("rejects other hosts, other GitLab instances, and non-upload paths", () => {
    const body = [
      "![a](https://gitlab.com/ns/proj/uploads/abc/x.png)",
      "![b](https://evil.example.com/uploads/abc/x.png)",
      "![c](/ns/proj/-/issues/9)",
    ].join("\n");
    expect(extractIssueImageUrls(body, GL)).toEqual([]);
  });

  it("scans notes as well as the description", () => {
    expect(
      extractIssueImageUrls(["desc", "note ![n](/uploads/note1/n.png)"], GL),
    ).toEqual(["https://gitlab.example.com/ns/proj/uploads/note1/n.png"]);
  });
});

describe("importIssueImageAttachments", () => {
  let store: { addAttachment: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    store = { addAttachment: vi.fn(async () => ({}) as never) };
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("downloads embedded images and attaches them to the task", async () => {
    const result = await importIssueImageAttachments(
      store as never,
      "FN-1",
      "![shot](https://github.com/user-attachments/assets/abc-123)",
      GH,
    );

    expect(result).toEqual({ attached: 1, failed: 0 });
    expect(store.addAttachment).toHaveBeenCalledTimes(1);
    const [taskId, filename, buffer, mimeType] = store.addAttachment.mock.calls[0]!;
    expect(taskId).toBe("FN-1");
    // user-attachments assets are extension-less UUIDs; the agent needs a name that reads as an image.
    expect(filename).toBe("issue-image-1.png");
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(mimeType).toBe("image/png");
  });

  it("preserves a real filename when the URL has an image extension", async () => {
    await importIssueImageAttachments(
      store as never,
      "FN-1",
      "![shot](https://user-images.githubusercontent.com/1/bug-report.png)",
      GH,
    );
    expect(store.addAttachment.mock.calls[0]![1]).toBe("bug-report.png");
  });

  it("sends the GitHub bearer token so private-repo attachments resolve", async () => {
    await importIssueImageAttachments(
      store as never,
      "FN-1",
      "![shot](https://github.com/user-attachments/assets/abc-123)",
      githubImagePolicy({ token: "ghp_secret" }),
    );
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer ghp_secret",
    );
  });

  it("sends the GitLab PRIVATE-TOKEN header so instance uploads resolve", async () => {
    await importIssueImageAttachments(store as never, "FN-1", "![shot](/uploads/abc/bug.png)", GL);
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://gitlab.example.com/ns/proj/uploads/abc/bug.png");
    expect((init as RequestInit & { headers: Record<string, string> }).headers["PRIVATE-TOKEN"]).toBe(
      "glpat-secret",
    );
    expect(store.addAttachment.mock.calls[0]![1]).toBe("bug.png");
  });

  it("does not attach a non-image response (e.g. an HTML login redirect)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("text/html")));
    const result = await importIssueImageAttachments(
      store as never,
      "FN-1",
      "![shot](https://github.com/user-attachments/assets/abc-123)",
      GH,
    );
    expect(result).toEqual({ attached: 0, failed: 1 });
    expect(store.addAttachment).not.toHaveBeenCalled();
  });

  it("skips images over the attachment size cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-type": "image/png", "content-length": String(6 * 1024 * 1024) }),
        arrayBuffer: async () => PNG.buffer,
      }) as unknown as Response),
    );
    const result = await importIssueImageAttachments(
      store as never,
      "FN-1",
      "![shot](https://github.com/user-attachments/assets/abc-123)",
      GH,
    );
    expect(result).toEqual({ attached: 0, failed: 1 });
    expect(store.addAttachment).not.toHaveBeenCalled();
  });

  it("never throws when a download fails — import must not fail over a screenshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      importIssueImageAttachments(
        store as never,
        "FN-1",
        "![shot](https://github.com/user-attachments/assets/abc-123)",
        GH,
      ),
    ).resolves.toEqual({ attached: 0, failed: 1 });
  });

  it("keeps attaching the remaining images after one fails", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await importIssueImageAttachments(
      store as never,
      "FN-1",
      "![a](https://github.com/user-attachments/assets/one)\n![b](https://github.com/user-attachments/assets/two)",
      GH,
    );
    expect(result).toEqual({ attached: 1, failed: 1 });
    expect(store.addAttachment).toHaveBeenCalledTimes(1);
  });

  it("attaches images found only in comments", async () => {
    const result = await importIssueImageAttachments(
      store as never,
      "FN-1",
      ["no image in the body", "![shot](https://github.com/user-attachments/assets/abc-123)"],
      GH,
    );
    expect(result).toEqual({ attached: 1, failed: 0 });
    expect(store.addAttachment).toHaveBeenCalledTimes(1);
  });

  it("makes no network calls for a body with no images", async () => {
    const result = await importIssueImageAttachments(store as never, "FN-1", "plain text issue", GH);
    expect(result).toEqual({ attached: 0, failed: 0 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
