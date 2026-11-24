import { equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./fixture.js";

test("the browser entry point can load its nested Tale and World modules", async t => {
  const app = await fixture(t);
  const page = await app.send("/");
  equal(page.status, 200);
  const entry = /type="module" src="([^"]+)"/.exec(await page.text())?.[1];
  equal(entry, "/client/app.js");

  const script = await app.send(entry);
  equal(script.status, 200);
  const imports = [...(await script.text()).matchAll(/from "(\.\/(?:tales|worlds)\/[^"]+\.js)"/g)].map(([, path]) => path);
  ok(imports.some(path => path.startsWith("./tales/")));
  ok(imports.some(path => path.startsWith("./worlds/")));
  for (const path of imports) {
    const pathname: string = new URL(path, app.origin + entry).pathname;
    const module = await app.send(pathname);
    equal(module.status, 200, pathname);
    match(module.headers.get("content-type") ?? "", /^text\/javascript/);
  }
  equal((await app.send("/server/main.js")).status, 404);
});
