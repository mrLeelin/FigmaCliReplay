import assert from "node:assert/strict";
import test from "node:test";

import { corsHeaders } from "../dist/utils.js";

test("CORS preflight responses advertise a bounded cache lifetime", () => {
  const headers = corsHeaders();
  assert.equal(headers["Access-Control-Max-Age"], "600");
});
