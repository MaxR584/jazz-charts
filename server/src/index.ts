import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildApp({ logger: true, maxPages: process.env.MAX_PDF_PAGES ? Number(process.env.MAX_PDF_PAGES) : undefined });

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
