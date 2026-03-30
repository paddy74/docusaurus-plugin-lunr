import { writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lunr from "lunr";
import { Worker } from "node:worker_threads";
import Gauge from "gauge";

import { generateLunrClientJS, getFilePaths } from "./utils.js";

export default function docusaurusPluginLunr(_context, options = {}) {
  let languages;

  const guid = String(Date.now());
  const fileNames = {
    searchDoc: `search-doc-${guid}.json`,
    lunrIndex: `lunr-index-${guid}.json`,
  };

  return {
    name: "docusaurus-plugin-lunr",
    getThemePath() {
      return fileURLToPath(new URL("./theme", import.meta.url));
    },
    configureWebpack(config) {
      // Docusaurus invokes configureWebpack() twice, for client and server; however generateLunrClientJS()
      // is a global configuration.
      if (languages === undefined) {
        // Multilingual issue fix
        const generatedFilesDir = config.resolve.alias["@generated"];
        languages = generateLunrClientJS(generatedFilesDir, options.languages);
      }
      return {};
    },
    async contentLoaded({ actions }) {
      actions.setGlobalData({ fileNames });
    },
    async postBuild({ routesPaths = [], outDir, baseUrl, plugins }) {
      console.log("docusaurus-plugin-lunr:: Building search docs and lunr index file");
      console.time("docusaurus-plugin-lunr:: Indexing time");

      const docsPlugin = plugins.find(
        (plugin) => plugin.name === "docusaurus-plugin-content-docs",
      );

      const [files, meta] = getFilePaths(routesPaths, outDir, baseUrl, options);
      if (meta.excludedCount) {
        console.log(
          `docusaurus-plugin-lunr:: ${meta.excludedCount} documents were excluded from the search by excludeRoutes config`,
        );
      }

      // Expose Lunr's fields configuration through docusaurus options.
      // Fields are used to configure how Lunr treats different sources of search terms.
      // This allows a user to boost the importance of certain fields over others.
      const fields = {
        title: { boost: 200, ...options.fields?.title },
        content: { boost: 2, ...options.fields?.content },
        keywords: { boost: 100, ...options.fields?.keywords },
      };

      const searchDocuments = [];
      const lunrBuilder = lunr(function (builder) {
        if (languages) {
          this.use(languages);
        }
        this.ref("id");
        Object.entries(fields).forEach(([key, value]) => this.field(key, value));
        this.metadataWhitelist = ["position"];

        const { build } = builder;
        builder.build = () => {
          builder.build = build;
          return builder;
        };
      });

      const loadedVersions =
        docsPlugin?.options &&
        !docsPlugin.options.disableVersioning &&
        !(options.disableVersioning ?? false)
          ? Object.fromEntries(
              docsPlugin.content.loadedVersions.map((loadedVersion) => [
                loadedVersion.versionName,
                loadedVersion.label,
              ]),
            )
          : null;

      if (options.stopWords) {
        const customStopWords = lunr.generateStopWordFilter(options.stopWords);
        lunrBuilder.pipeline.before(lunr.stopWordFilter, customStopWords);
        lunrBuilder.pipeline.remove(lunr.stopWordFilter);
      }
      const addToSearchData = (d) => {
        if (options.excludeTags && options.excludeTags.includes(d.tagName)) {
          return;
        }
        lunrBuilder.add({
          id: searchDocuments.length,
          title: d.title,
          content: d.content,
          keywords: d.keywords,
        });
        searchDocuments.push(d);
      };

      const indexedDocuments = await buildSearchData(
        files,
        addToSearchData,
        loadedVersions,
      );
      const lunrIndex = lunrBuilder.build();
      console.timeEnd("docusaurus-plugin-lunr:: Indexing time");
      console.log(
        `docusaurus-plugin-lunr:: indexed ${indexedDocuments} documents out of ${files.length}`,
      );

      const searchDocFileContents = JSON.stringify({
        searchDocs: searchDocuments,
        options,
      });
      console.log("docusaurus-plugin-lunr:: writing search-doc.json");
      // This file is written for backwards-compatibility with components swizzled from v2.1.12 or earlier.
      await writeFile(path.join(outDir, "search-doc.json"), searchDocFileContents);
      console.log(`docusaurus-plugin-lunr:: writing ${fileNames.searchDoc}`);
      await writeFile(path.join(outDir, fileNames.searchDoc), searchDocFileContents);

      const lunrIndexFileContents = JSON.stringify(lunrIndex);
      console.log("docusaurus-plugin-lunr:: writing lunr-index.json");
      // This file is written for backwards-compatibility with components swizzled from v2.1.12 or earlier.
      await writeFile(path.join(outDir, "lunr-index.json"), lunrIndexFileContents);
      console.log(`docusaurus-plugin-lunr:: writing ${fileNames.lunrIndex}`);
      await writeFile(path.join(outDir, fileNames.lunrIndex), lunrIndexFileContents);
      console.log("docusaurus-plugin-lunr:: End of process");
    },
  };
}

function buildSearchData(files, addToSearchData, loadedVersions) {
  if (!files.length) {
    return Promise.resolve(0);
  }
  const workerCount = Math.min(files.length, Math.max(2, availableParallelism()));

  console.log(
    `docusaurus-plugin-lunr:: Start scanning documents in ${workerCount} threads`,
  );
  const gauge = new Gauge();
  gauge.show("scanning documents...");
  let indexedDocuments = 0; // Documents that have added at least one value to the index

  const { promise, resolve, reject } = Promise.withResolvers();
  let activeWorkersCount = 0;
  let nextIndex = 0;
  let completed = false;

  const finish = (finishFn, value) => {
    if (completed) {
      return;
    }
    completed = true;
    gauge.hide();
    finishFn(value);
  };

  const dispatchNextFile = (worker) => {
    if (nextIndex < files.length) {
      worker.postMessage(files[nextIndex++]);
      return;
    }
    worker.postMessage(null);
  };

  const handleMessage = ([isDoc, payload], worker) => {
    gauge.pulse();
    if (isDoc) {
      addToSearchData(payload);
      return;
    }

    indexedDocuments += payload;
    gauge.show(
      `scanned ${nextIndex} files out of ${files.length}`,
      nextIndex / files.length,
    );
    dispatchNextFile(worker);
  };

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(new URL("./html-to-doc.js", import.meta.url), {
      workerData: { loadedVersions },
    });

    worker.on("error", (error) => finish(reject, error));
    worker.on("message", (message) => {
      handleMessage(message, worker);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`Scanner stopped with exit code ${code}`));
        return;
      }

      activeWorkersCount--;
      if (activeWorkersCount <= 0) {
        finish(resolve, indexedDocuments);
      }
    });

    activeWorkersCount++;
    dispatchNextFile(worker);
    gauge.pulse();
  }

  return promise;
}
