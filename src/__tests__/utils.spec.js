import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateLunrClientJS, getFilePaths } from "../utils.js";

const outDir = "/out";
const baseUrl = "http://example.com/";

describe("utils", () => {
  it("should not include routes matching globs provided in `excludeRoutes` options", () => {
    const routesPaths = [
      `${baseUrl}docs/tutorial/overview`,
      `${baseUrl}docs/tutorial/get-started`,
      `${baseUrl}docs/how-to/add-plugin`,
      `${baseUrl}docs/how-to/extract-value`,
      `${baseUrl}docs/explanation/solar-system`,
      `${baseUrl}docs/changelogs/index`,
      `${baseUrl}docs/changelogs/rovers/lunar`,
    ];

    const [files, meta] = getFilePaths(routesPaths, outDir, baseUrl, {
      excludeRoutes: ["docs/changelogs/**/*"],
    });

    assert.deepEqual(
      files.map((f) => f.url),
      [
        `${baseUrl}docs/tutorial/overview`,
        `${baseUrl}docs/tutorial/get-started`,
        `${baseUrl}docs/how-to/add-plugin`,
        `${baseUrl}docs/how-to/extract-value`,
        `${baseUrl}docs/explanation/solar-system`,
      ],
    );

    assert.equal(meta.excludedCount, 2);
  });

  it("should generate a client that imports lunr from the package export", async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), "lunr-client-"));

    try {
      generateLunrClientJS(outDir);

      const generatedClient = await readFile(
        path.join(outDir, "lunr.client.js"),
        "utf8",
      );

      assert.match(
        generatedClient,
        /import lunr from "docusaurus-plugin-lunr\/lunr\.client";/,
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
