import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PROFILE } from "../src/db/repo";
import { profileFromOrg } from "../src/lib/profile";

test("a phone that signs in to a server first takes the company's name, country, currency and GST state", () => {
  const p = profileFromOrg({ legalName: " Demo Traders Pvt Ltd ", country: "IN", currency: "INR", gstStateCode: "27" });
  assert.equal(p.name, "Demo Traders Pvt Ltd"); assert.equal(p.gstState, "27"); assert.equal(p.currency, "INR"); assert.equal(p.country, "IN");
  assert.equal(p.invoicePrefix, DEFAULT_PROFILE.invoicePrefix, "everything else keeps the defaults");
});
test("a company outside India, with no GST state, still gets a usable profile", () => {
  const p = profileFromOrg({ legalName: "", country: "ES", currency: "EUR", gstStateCode: "" });
  assert.equal(p.name, "My business"); assert.equal(p.country, "ES"); assert.equal(p.currency, "EUR"); assert.equal(p.gstState, "");
});
